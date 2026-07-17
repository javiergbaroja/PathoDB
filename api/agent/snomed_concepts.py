"""Axis decomposition and code-family expansion over the SNOMED vocabulary.

A diagnosis phrase carries information on two INDEPENDENT axes: "colorectal
adenocarcinoma" is topography (colorectum) AND morphology (adenocarcinoma), and
probes code them in two separate columns. Nothing in the tool surface used to
say so, so the agent searched the flat vocabulary for the whole phrase, matched
nothing (no description contains "colorectal adenocarcinoma"), and reported an
absence of cases. Splitting the phrase per axis and expanding each to its full
code family is deterministic work the model should not be improvising.

Pure functions over vocabulary rows ({code, category, description}) — no DB, no
embeddings, no pydantic — so the expansion rules are unit-testable in isolation.
Callers (tools.resolve_diagnosis) supply the rows and the semantic seeds.

Two different expansion rules, because the two axes are built differently:

TOPOGRAPHY is prefix-coherent. The first 3 characters are the organ and the
remaining digits are subsites: T67* is colon and every part of it (cecum,
sigmoid, flexures, serosa), T68* is rectum and its parts. So a family is a
prefix, and expanding a prefix is complete by construction.

MORPHOLOGY is NOT prefix-coherent — adenocarcinoma NOS is M81403 but papillary
adenocarcinoma is M82603, four "digits" away. What IS systematic is the
description format "<head>, <qualifier>": every true adenocarcinoma variant reads
"adenocarcinoma, <something>". So the family is the head term. This also draws
the right line at the edges: "suspected adenocarcinoma" (an uncertainty
statement) and "cystadenocarcinoma" (a different entity) have different heads and
land in `related`, for a human to accept or reject, rather than being silently
swept into a cohort.
"""

# Last digit of an ICD-O style morphology code. A "find all adenocarcinomas"
# cohort usually means the malignant primaries (/3) — a metastasis to the colon
# (/6) is not a colorectal primary, and /0 is benign. Kept visible rather than
# filtered, so the caller decides.
BEHAVIOR_LABELS = {
    "0": "benign",
    "1": "uncertain whether benign or malignant",
    "2": "carcinoma in situ",
    "3": "malignant, primary",
    "6": "malignant, metastatic",
}

TOPO_PREFIX_WIDTH = 3          # "T67" — organ; the rest of the code is subsite

# Composite anatomical adjectives -> the organs they name. Not derivable: no
# description contains "colorectal", and asking an embedder to infer that it
# means colon AND rectum makes a cohort's completeness depend on cosine
# similarity landing two organs within a hair of each other. These are the terms
# clinicians actually use; resolving each constituent separately and unioning
# the result is deterministic. Extend as needed — it is data, not logic.
REGION_ALIASES = {
    "colorectal": ["colon", "rectum"],
    "colorectum": ["colon", "rectum"],
    "large bowel": ["colon", "rectum"],
    "large intestine": ["colon", "rectum"],
    "anorectal": ["anus", "rectum"],
    "rectosigmoid": ["rectum", "sigmoid colon"],
    "gastroesophageal": ["stomach", "esophagus"],
    "gastro-oesophageal": ["stomach", "esophagus"],
    "upper gi": ["esophagus", "stomach", "duodenum"],
    "upper gastrointestinal": ["esophagus", "stomach", "duodenum"],
    "small bowel": ["small intestine", "jejunum", "ileum", "duodenum"],
    "hepatobiliary": ["liver", "gallbladder", "bile duct"],
}


def lexical_score(term: str, description: str) -> float:
    """How specifically `description` is ABOUT `term`, in [0, 1].

    A flat "it matched" score is wrong here, because a term appears in
    descriptions where it is not the subject: 'colon' occurs in 'colon' (T67000)
    and in 'stomach and colon' (T63920) and 'ileum and colon' (T65900). Scoring
    every hit 1.0 ties those organs with the colon itself, and since a family is
    an expanded prefix, one tie would silently pull all of stomach into a colon
    cohort.

    Specificity = how much of the description the term accounts for. An exact
    match scores 1.0; a term buried in a multi-organ description scores low
    enough to fall outside select_families' margin.
    """
    t, d = _norm(term), _norm(description)
    if not t or not d or t not in d:
        return 0.0
    if t == d:
        return 1.0
    return min(0.99, len(t) / len(d))


def head_term(description: str) -> str:
    """The taxonomic head of a description: 'adenocarcinoma, papillary' -> 'adenocarcinoma'."""
    return (description or "").split(",")[0].strip().lower()


def behavior_of(code: str) -> str | None:
    """Behavior digit of a morphology code, or None if it has no numeric suffix."""
    code = (code or "").strip()
    return code[-1] if code and code[-1].isdigit() else None


def _norm(s: str) -> str:
    return (s or "").strip().lower()


def expand_morphology(rows: list, term: str) -> dict:
    """Group morphology codes for `term` into an exact family plus near-misses.

    core    — head term == term. The family proper.
    related — head term merely CONTAINS term ('suspected adenocarcinoma'), or the
              term appears elsewhere in the description. Clinically adjacent and
              deliberately not auto-included.

    Returns {"core": [...], "related": [...]} with each row carrying its behavior.
    """
    t = _norm(term)
    core, related = [], []
    for r in rows:
        if r.get("category") != "morphology":
            continue
        desc = r.get("description") or ""
        head = head_term(desc)
        if not t:
            continue
        entry = dict(r)
        beh = behavior_of(r.get("code", ""))
        entry["behavior"] = BEHAVIOR_LABELS.get(beh) if beh else None
        if head == t:
            core.append(entry)
        elif t in head or t in _norm(desc):
            related.append(entry)
    core.sort(key=lambda r: r["code"])
    related.sort(key=lambda r: r["code"])
    return {"core": core, "related": related}


def prefix_families(seeds: list, width: int = TOPO_PREFIX_WIDTH) -> dict:
    """Group seed rows by code prefix -> {prefix: {"best_score", "seeds": [...]}}.

    Seeds are the lexical/semantic hits for the term. Grouping them by organ
    prefix is what turns a handful of fuzzy matches into a decision about which
    ORGANS the term meant — and the organ is the unit that expands completely.
    """
    fams: dict = {}
    for s in seeds:
        code = s.get("code") or ""
        if len(code) < width:
            continue
        p = code[:width]
        f = fams.setdefault(p, {"best_score": 0.0, "seeds": []})
        f["seeds"].append(s)
        f["best_score"] = max(f["best_score"], float(s.get("score") or 0.0))
    return fams


def select_families(fams: dict, margin: float = 0.08) -> list:
    """Which prefix families the term actually meant, best-scoring first.

    Keeps every family scoring within `margin` of the best one. 'colorectal'
    seeds colon and rectum near-equally so both survive; 'colon' leaves T68 far
    enough behind that it does not. A stray seed under an unrelated prefix
    ('rectus abdominis muscle' for 'rect') scores well below the margin and is
    dropped — which matters, because expanding a wrong prefix would silently
    pull in a whole unrelated organ.
    """
    if not fams:
        return []
    top = max(f["best_score"] for f in fams.values())
    keep = [(p, f) for p, f in fams.items() if f["best_score"] >= top - margin]
    keep.sort(key=lambda pf: -pf[1]["best_score"])
    return [p for p, _ in keep]


def expand_topography(rows: list, prefixes: list) -> list:
    """Every topography code under the given organ prefixes, code order.

    Complete by construction: the prefix IS the organ, so this cannot miss a
    subsite the way an enumerated list of guessed descriptions does.
    """
    pfx = tuple(prefixes)
    if not pfx:
        return []
    out = [dict(r) for r in rows
           if r.get("category") == "topography" and (r.get("code") or "").startswith(pfx)]
    out.sort(key=lambda r: r["code"])
    return out


def related_topography(rows: list, term: str, chosen_prefixes: list) -> list:
    """Topography codes mentioning `term` but OUTSIDE the chosen organ families.

    These are the genuinely ambiguous multi-organ codes — 'ileum and colon'
    (T65900) names the colon but files under small intestine. Surfaced for a
    judgement call instead of being silently included or silently lost.
    """
    t = _norm(term)
    pfx = tuple(chosen_prefixes)
    if not t:
        return []
    out = [dict(r) for r in rows
           if r.get("category") == "topography"
           and t in _norm(r.get("description"))
           and not (pfx and (r.get("code") or "").startswith(pfx))]
    out.sort(key=lambda r: r["code"])
    return out
