from inventory.stock import restock, ratio


def test_restock_adds_quantity():
    item = {"count": 1}
    assert restock(item, 2)["count"] == 3


def test_ratio_half():
    assert ratio(1, 2) == 0.5
