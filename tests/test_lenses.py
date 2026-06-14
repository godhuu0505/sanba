from interviewer.lenses import LENSES, is_lens_id, render_lens_catalogue


def test_catalogue_unique_ids():
    ids = [lens.id for lens in LENSES]
    assert len(ids) == len(set(ids))
    assert len(ids) >= 10


def test_is_lens_id():
    assert is_lens_id("first_principles")
    assert is_lens_id("five_whys")
    assert not is_lens_id("nonsense")
    assert not is_lens_id(42)


def test_render_contains_every_lens():
    rendered = render_lens_catalogue()
    for lens in LENSES:
        assert lens.id in rendered
        assert lens.name in rendered
