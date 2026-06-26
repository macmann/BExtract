import json

from server.pipeline import _parse_critic_response, route_critic_result


class DummyContext:
    def __init__(self, state):
        self.state = state


def test_parse_critic_response_accepts_fenced_json():
    parsed = _parse_critic_response('```json\n{"status":"pass","corrected_payload":null}\n```')

    assert parsed["status"] == "pass"
    assert "parse_warning" not in parsed


def test_parse_critic_response_extracts_embedded_json():
    parsed = _parse_critic_response('Critique result: {"status":"fail","failed_item_id":"assets","failed_item_type":"Scalar","critique":"bad","corrected_payload":null}')

    assert parsed["status"] == "fail"
    assert parsed["failed_item_id"] == "assets"


def test_parse_critic_response_falls_back_for_empty_output():
    parsed = _parse_critic_response("")

    assert parsed["status"] == "pass"
    assert "empty response" in parsed["critique"]


def test_route_critic_result_does_not_raise_on_empty_output():
    ctx = DummyContext({"critic_output": "", "critic_result": {}})

    event = route_critic_result(ctx)

    assert ctx.state["critic_result"]["status"] == "pass"
    assert event.actions.route == "db_commit"
