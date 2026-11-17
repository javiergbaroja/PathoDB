"""Stain filters that see multi-stain slides."""
from sqlalchemy.orm import Session, aliased

from ..models import Stain, StainComponent


def stains_including(db: Session, names: list[str]) -> list[str]:
    """
    The named stains plus every multi-stain row containing one of them, so that
    a filter on CD8 also finds "AE1/AE3 + CD8". Asking for the multi-stain row
    itself finds only that row.
    """
    component = aliased(Stain)
    rows = (
        db.query(Stain.stain_name)
        .join(StainComponent, StainComponent.stain_id == Stain.id)
        .join(component, component.id == StainComponent.component_stain_id)
        .filter(component.stain_name.in_(names))
        .all()
    )
    return list(names) + [name for (name,) in rows]
