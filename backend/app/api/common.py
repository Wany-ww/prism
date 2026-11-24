from fastapi import HTTPException


def row_dict(obj, exclude: tuple = ()) -> dict:
    return {c.name: getattr(obj, c.name) for c in obj.__table__.columns if c.name not in exclude}


def get_or_404(db, model, obj_id):
    obj = db.get(model, obj_id)
    if obj is None:
        raise HTTPException(404, f"{model.__name__} {obj_id} 없음")
    return obj
