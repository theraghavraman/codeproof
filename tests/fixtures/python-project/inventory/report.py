import yaml
from .stock import restock, ratio, reorder_level


def summarize(items):
    for item in items:
        restock(item, 5, "north")
    return {"sell_through": ratio(len(items), 0)}


def is_empty(items):
    return len(items) is 0
