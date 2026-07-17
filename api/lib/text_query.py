"""
Google-style keyword queries → Postgres tsquery.

Used by the cohort report-text filters (micro/macro). Accepts the syntax a
user already knows from a web search box and compiles it to a tsquery string
suitable for `to_tsquery(TS_CONFIG, …)`.

    carcinoma colon              both words (space = AND)
    carcinoma OR adenoma         either word
    "lymph node"                 exact phrase, words adjacent in that order
    -metastasis                  must NOT appear (also: NOT metastasis)
    (carcinoma OR adenoma) colon grouping
    carcinom*                    prefix — matches carcinoma, carcinomas, …

Grammar (keywords case-insensitive):

    expr    := or_expr
    or_expr := and_expr (("OR" | "|") and_expr)*
    and_expr:= unary (("AND" | "&")? unary)*      -- juxtaposition means AND
    unary   := ("NOT" | "-" | "!") unary | primary
    primary := "(" expr ")" | '"' phrase '"' | term

Matching is word-level and unstemmed, against the `reports.report_tsv` generated
column, so TS_CONFIG must stay in step with that column ('simple') or its GIN
index is bypassed. Unstemmed means "tumor" does not match "tumors", which makes
the prefix form load-bearing rather than a nicety — see db/schema.sql for why
'simple' beats 'english' on this corpus (short version: English stemming splits
metastasis/metastases apart and breaks prefix search).
"""
import re

# Must match the config used by the reports.report_tsv generated column.
TS_CONFIG = "simple"

# Bare words end at whitespace or at a character with syntactic meaning. '-' and
# '!' are absent so that "well-differentiated" and "HER2!" stay single terms —
# they are only operators in prefix position (see _tokenize).
_WORD_END = set(' \t\n\r\f\v()"&|')

# A prefix '-'/'!' negates whatever starts next — a word, a "phrase" or a (group).
# Anything else after it (space, ')', another operator) means it is not a negation.
_NOT_FOLLOWERS_EXCLUDED = set(' \t\n\r\f\v)&|')

_OPERATORS = {"OR": "OR", "AND": "AND", "NOT": "NOT"}


class QueryParseError(ValueError):
    """Raised for input the user can fix — the message is shown to them."""


# ─── Tokenizer ────────────────────────────────────────────────────────────────

def _tokenize(s: str) -> list[tuple[str, str]]:
    tokens: list[tuple[str, str]] = []
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c.isspace():
            i += 1
        elif c == "(":
            tokens.append(("LPAREN", c)); i += 1
        elif c == ")":
            tokens.append(("RPAREN", c)); i += 1
        elif c == "&":
            tokens.append(("AND", c)); i += 1
        elif c == "|":
            tokens.append(("OR", c)); i += 1
        elif c == '"':
            j = s.find('"', i + 1)
            if j == -1:
                raise QueryParseError('Unclosed quote — every " needs a closing ".')
            tokens.append(("PHRASE", s[i + 1:j])); i = j + 1
        elif c in "-!" and i + 1 < n and s[i + 1] not in _NOT_FOLLOWERS_EXCLUDED:
            # Negation only in prefix position, so "-metastasis" negates but the
            # hyphen in "well-differentiated" does not.
            tokens.append(("NOT", c)); i += 1
        else:
            j = i
            while j < n and s[j] not in _WORD_END:
                j += 1
            word = s[i:j]
            kind = _OPERATORS.get(word.upper(), "WORD")
            tokens.append((kind, word))
            i = j
    return tokens


# ─── Parser ───────────────────────────────────────────────────────────────────
#
# AST nodes: ("and"|"or", [child, …]) | ("not", child)
#            ("term", word) | ("phrase", [word, …])

class _Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.pos = 0

    def _peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else (None, None)

    def _next(self):
        tok = self._peek()
        self.pos += 1
        return tok

    def parse(self):
        node = self._parse_or()
        kind, val = self._peek()
        if kind is not None:
            raise QueryParseError(f"Unexpected '{val}' — check the parentheses.")
        return node

    def _parse_or(self):
        children = [self._parse_and()]
        while self._peek()[0] == "OR":
            self._next()
            children.append(self._parse_and())
        return children[0] if len(children) == 1 else ("or", children)

    def _parse_and(self):
        children = [self._parse_unary()]
        while True:
            kind, _ = self._peek()
            if kind == "AND":
                self._next()
                children.append(self._parse_unary())
            elif kind in ("WORD", "PHRASE", "NOT", "LPAREN"):
                children.append(self._parse_unary())   # juxtaposition = AND
            else:
                break
        return children[0] if len(children) == 1 else ("and", children)

    def _parse_unary(self):
        if self._peek()[0] == "NOT":
            self._next()
            return ("not", self._parse_unary())
        return self._parse_primary()

    def _parse_primary(self):
        kind, val = self._next()
        if kind == "LPAREN":
            node = self._parse_or()
            if self._next()[0] != "RPAREN":
                raise QueryParseError("Unclosed '(' — every ( needs a closing ).")
            return node
        if kind == "PHRASE":
            words = val.split()
            if not words:
                raise QueryParseError('Empty quotes — put a word inside the "".')
            return ("phrase", words)
        if kind == "WORD":
            return ("term", val)
        if kind is None:
            raise QueryParseError("Query ends after an operator — a term is missing.")
        raise QueryParseError(f"Unexpected '{val}'.")


# ─── Compiler ─────────────────────────────────────────────────────────────────

def _lexeme(word: str) -> str:
    """Quote one word as a tsquery lexeme, honouring a trailing '*' as prefix."""
    prefix = word.endswith("*")
    if prefix:
        word = word[:-1]
    if not word:
        raise QueryParseError("'*' needs a word in front of it, e.g. carcinom*")
    if not any(ch.isalnum() for ch in word):
        raise QueryParseError(f"'{word}' has no letters or digits to search for.")
    escaped = word.replace("\\", "\\\\").replace("'", "''")
    return f"'{escaped}':*" if prefix else f"'{escaped}'"


def _compile(node) -> str:
    kind = node[0]
    if kind == "term":
        return _lexeme(node[1])
    if kind == "phrase":
        # <-> is "immediately followed by", which is what a quoted phrase means.
        return "(" + " <-> ".join(_lexeme(w) for w in node[1]) + ")"
    if kind == "not":
        return "!(" + _compile(node[1]) + ")"
    joiner = " & " if kind == "and" else " | "
    return "(" + joiner.join(_compile(c) for c in node[1]) + ")"


def to_tsquery_string(query: str) -> str:
    """Compile a Google-style query into a tsquery string.

    Returns '' for blank input, which callers treat as "no filter" — an empty
    tsquery matches nothing, so it must never reach the database.

    Raises QueryParseError with a user-facing message on malformed input.
    """
    if not query or not query.strip():
        return ""
    node = _Parser(_tokenize(query)).parse()
    return _compile(node)
