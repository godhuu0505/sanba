from typing import Any

from sanba_shared.analytics import PRICING
from sanba_shared.analytics_setup import (
    ANALYTICS_DATA_STREAM,
    ANALYTICS_ILM_POLICY,
    ANALYTICS_INDEX_TEMPLATE,
    PRICING_INDEX,
    ensure_event_stream_template,
    event_mappings,
    is_serverless,
    setup_analytics,
)


class FakeIndices:
    def __init__(self, *, template_exists: bool = False) -> None:
        self._template_exists = template_exists
        self.templates: list[dict[str, Any]] = []
        self.created_indices: list[str] = []
        self.created_data_streams: list[str] = []
        self.existing: set[str] = set()

    def exists_index_template(self, name: str) -> bool:
        return self._template_exists

    def put_index_template(self, **kwargs: Any) -> None:
        self._template_exists = True
        self.templates.append(kwargs)

    def exists(self, index: str) -> bool:
        return index in self.existing

    def create(self, index: str, **kwargs: Any) -> None:
        self.existing.add(index)
        self.created_indices.append(index)

    def create_data_stream(self, name: str) -> None:
        self.existing.add(name)
        self.created_data_streams.append(name)


class FakeIlm:
    def __init__(self) -> None:
        self.policies: list[dict[str, Any]] = []

    def put_lifecycle(self, **kwargs: Any) -> None:
        self.policies.append(kwargs)


class FakeES:
    def __init__(self, *, template_exists: bool = False) -> None:
        self.indices = FakeIndices(template_exists=template_exists)
        self.ilm = FakeIlm()
        self.docs: list[dict[str, Any]] = []

    def index(self, *, index: str, document: dict[str, Any], id: str | None = None) -> None:
        self.docs.append({"index": index, "id": id, "document": document})


def test_ensure_event_stream_template_creates_only_when_missing() -> None:
    client = FakeES()
    assert ensure_event_stream_template(client) is True
    template = client.indices.templates[0]
    assert template["name"] == ANALYTICS_INDEX_TEMPLATE
    assert "index.lifecycle.name" not in template["template"]["settings"]
    existing = FakeES(template_exists=True)
    assert ensure_event_stream_template(existing) is False
    assert existing.indices.templates == []


def test_setup_analytics_is_idempotent_and_full() -> None:
    client = FakeES()
    setup_analytics(client, retention_days=180)
    setup_analytics(client, retention_days=180)
    assert len(client.ilm.policies) == 2
    policy = client.ilm.policies[0]
    assert policy["name"] == ANALYTICS_ILM_POLICY
    assert policy["policy"]["phases"]["delete"]["min_age"] == "180d"
    template = client.indices.templates[0]
    assert template["template"]["settings"]["index.lifecycle.name"] == ANALYTICS_ILM_POLICY
    assert client.indices.created_data_streams == [ANALYTICS_DATA_STREAM]
    assert client.indices.created_indices == [PRICING_INDEX]
    pricing_docs = [d for d in client.docs if d["index"] == PRICING_INDEX]
    assert len(pricing_docs) == 2 * len(PRICING)
    assert {d["id"] for d in pricing_docs} == set(PRICING)


class FakeServerlessES(FakeES):
    def info(self) -> dict[str, Any]:
        return {"version": {"build_flavor": "serverless"}}


class FakeInfoRaisesES(FakeES):
    def info(self) -> dict[str, Any]:
        raise RuntimeError("action [cluster:monitor/main] is unauthorized")


class FakeMalformedInfoES(FakeES):
    def info(self) -> str:
        return "not-a-dict"


def test_is_serverless_detects_flavor_and_defaults_false() -> None:
    assert is_serverless(FakeServerlessES()) is True
    assert is_serverless(FakeES()) is False


def test_is_serverless_falls_back_to_safe_side_when_info_fails() -> None:
    assert is_serverless(FakeInfoRaisesES()) is True
    assert is_serverless(FakeMalformedInfoES()) is True


def test_ensure_event_stream_template_uses_safe_side_when_info_fails() -> None:
    client = FakeInfoRaisesES()
    assert ensure_event_stream_template(client) is True
    template = client.indices.templates[0]["template"]
    assert "settings" not in template
    assert template["lifecycle"]["data_retention"].endswith("d")


def test_ensure_event_stream_template_serverless_omits_replicas_and_ilm() -> None:
    client = FakeServerlessES()
    assert ensure_event_stream_template(client) is True
    template = client.indices.templates[0]["template"]
    assert "settings" not in template
    assert template["lifecycle"]["data_retention"].endswith("d")


def test_setup_analytics_serverless_skips_ilm_and_uses_data_stream_lifecycle() -> None:
    client = FakeServerlessES()
    setup_analytics(client, retention_days=90)
    assert client.ilm.policies == []
    template = client.indices.templates[0]["template"]
    assert "settings" not in template
    assert template["lifecycle"]["data_retention"] == "90d"
    assert client.indices.created_data_streams == [ANALYTICS_DATA_STREAM]
    assert client.indices.created_indices == [PRICING_INDEX]


def test_event_mappings_cover_core_fields() -> None:
    props = event_mappings()["properties"]
    assert props["session_id"] == {"type": "keyword"}
    assert props["product_id"] == {"type": "keyword"}
    payload = props["payload"]["properties"]
    assert payload["estimated_usd"] == {"type": "double"}
    assert payload["tokens"]["properties"]["input_audio_tokens"] == {"type": "long"}
    assert payload["efficiency"]["properties"]["usd_per_finalized_requirement"] == {
        "type": "double"
    }
