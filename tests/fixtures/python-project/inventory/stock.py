def restock(item, quantity, *, warehouse="main"):
    if quantity <= 0:
        raise ValueError("quantity must be positive")
    item["count"] = item.get("count", 0) + quantity
    return item


def ratio(sold, total):
    return sold / total


def add_tag(item, tag, tags=[]):
    tags.append(tag)
    item["tags"] = tags
    return item
