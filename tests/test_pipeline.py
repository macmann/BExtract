import json

import pytest

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


def test_normalize_workflow_results_matches_keys_case_space_and_underscore_insensitive():
    from server.pipeline import normalize_workflow_results

    template = {"items": [{"id": "rating_action", "name": "Rating Action", "dataType": "String"}]}
    workflow_output = {
        "state": {
            "compiled_payload": {
                "results": {
                    "Rating action": {
                        "Item ID": "Rating Action",
                        "Field Name": "Rating Action",
                        "Value": "Affirmed",
                        "Confidence": 0.93,
                        "Evidence": "Example evidence",
                    }
                }
            }
        }
    }

    normalized = normalize_workflow_results(template, workflow_output)

    assert normalized["rating_action"]["value"] == "Affirmed"
    assert normalized["rating_action"]["confidence"] == 0.93


def test_calculate_token_cost_metrics_sums_adk_event_usage_metadata():
    from server.pipeline import calculate_token_cost_metrics

    workflow_output = {
        "events": [
            {"content": {"usage_metadata": {"prompt_token_count": 1000, "candidates_token_count": 200}}},
            {"content": {"usageMetadata": {"promptTokenCount": 3000, "candidatesTokenCount": 800}}},
        ],
        "state": {"usage_metadata": {"prompt_token_count": 999999, "candidates_token_count": 999999}},
    }

    metrics = calculate_token_cost_metrics(workflow_output)

    assert metrics["input_tokens"] == 4000
    assert metrics["output_tokens"] == 1000
    assert metrics["total_tokens"] == 5000
    assert metrics["input_cost"] == 0.006
    assert metrics["output_cost"] == pytest.approx(0.009)
    assert metrics["total_cost"] == pytest.approx(0.015)


def test_log_token_cost_metrics_prints_formatted_block(capsys):
    from server.pipeline import log_token_cost_metrics

    log_token_cost_metrics(
        {
            "input_tokens": 1234,
            "output_tokens": 56,
            "total_tokens": 1290,
            "input_cost": 0.001851,
            "output_cost": 0.000504,
            "total_cost": 0.002355,
        }
    )

    captured = capsys.readouterr().out
    assert "=== BEXTRACT TOKEN & COST METRICS ===" in captured
    assert "[Input]   Tokens: 1,234 | Cost: $0.0019" in captured
    assert "[Output]  Tokens: 56 | Cost: $0.0005" in captured
    assert "[Total]   Tokens: 1,290 | Total Cost: $0.0024" in captured


def test_record_node_token_audit_appends_and_prints_trace(capsys):
    from server.pipeline import record_node_token_audit

    summary = []
    event = {
        "author": "Example_Extractor",
        "content": {"usage_metadata": {"prompt_token_count": 24500, "candidates_token_count": 350}},
    }

    entry = record_node_token_audit(summary, event, {"field": "value"})

    assert entry["node_name"] == "Example_Extractor"
    assert entry["input_tokens"] == 24500
    assert entry["output_tokens"] == 350
    assert summary == [entry]
    captured = capsys.readouterr().out
    assert "--- ADK NODE TRACE: Example_Extractor ---" in captured
    assert "* Step Input Tokens:  24,500" in captured
    assert "* Step Output Tokens: 350" in captured


def test_log_graph_token_audit_ledger_prints_rows(capsys):
    from server.pipeline import log_graph_token_audit_ledger

    log_graph_token_audit_ledger(
        [
            {
                "node_name": "Example_Critic",
                "input_tokens": 24850,
                "output_tokens": 120,
                "estimated_cost": 0.038355,
            }
        ]
    )

    captured = capsys.readouterr().out
    assert "BEXTRACT GRAPH TOKEN AUDIT LEDGER" in captured
    assert "Example_Critic" in captured
    assert "24,850" in captured
    assert "120" in captured
    assert "$0.0384" in captured


def test_stateless_callback_keeps_only_current_user_turn():
    from google.adk.models.llm_request import LlmRequest
    from google.genai import types

    from server.pipeline import _reset_llm_request_to_stateless_turn

    request = LlmRequest(
        contents=[
            types.Content(role="user", parts=[types.Part(text="old extraction input")]),
            types.Content(role="model", parts=[types.Part(text="old extraction output")]),
            types.Content(role="user", parts=[types.Part(text="current extraction input")]),
        ],
        previous_interaction_id="leaky-provider-history",
    )

    result = _reset_llm_request_to_stateless_turn(callback_context=None, llm_request=request)

    assert result is None
    assert request.previous_interaction_id is None
    assert len(request.contents) == 1
    assert request.contents[0].parts[0].text == "current extraction input"


def test_stateless_callback_preserves_tool_continuation_turns():
    from google.adk.models.llm_request import LlmRequest
    from google.genai import types

    from server.pipeline import _reset_llm_request_to_stateless_turn

    request = LlmRequest(
        contents=[
            types.Content(role="user", parts=[types.Part(text="current extraction input")]),
            types.Content(
                role="model",
                parts=[types.Part.from_function_call(name="document_hybrid_search", args={"field_name": "Entity Name"})],
            ),
            types.Content(
                role="tool",
                parts=[types.Part.from_function_response(name="document_hybrid_search", response={"result": "AEON"})],
            ),
        ],
        previous_interaction_id="active-tool-turn",
    )

    result = _reset_llm_request_to_stateless_turn(callback_context=None, llm_request=request)

    assert result is None
    assert request.previous_interaction_id == "active-tool-turn"
    assert len(request.contents) == 3
    assert request.contents[1].parts[0].function_call.name == "document_hybrid_search"
    assert request.contents[2].parts[0].function_response.name == "document_hybrid_search"


def test_extractor_and_critic_agents_disable_adk_history_inclusion():
    from server.pipeline import critic_agent, scalar_extractor, tabular_extractor

    assert scalar_extractor.include_contents == "none"
    assert tabular_extractor.include_contents == "none"
    assert critic_agent.include_contents == "none"


def test_collect_item_parses_and_removes_raw_agent_output_from_state():
    from server.pipeline import _make_collect_item

    ctx = DummyContext(
        {
            "extract_assets_output": '{"item_id":"assets","value":123}',
            "current_item": {"item_id": "assets"},
            "extraction_results": {},
        }
    )

    output = _make_collect_item("assets", "extract_assets_output")(ctx)

    assert output["result"]["value"] == 123
    assert ctx.state["extraction_results"]["assets"]["value"] == 123
    assert "extract_assets_output" not in ctx.state
    assert "current_item" not in ctx.state


def test_route_critic_result_commits_when_failed_item_id_is_unknown(capsys):
    ctx = DummyContext(
        {
            "template_payload": {"items": [{"id": "assets", "name": "Assets"}]},
            "critic_output": json.dumps(
                {
                    "status": "fail",
                    "failed_item_id": "missing_item",
                    "critique": "Could not validate this field.",
                }
            ),
            "extractor_critiques": {},
        }
    )

    event = route_critic_result(ctx)

    assert event.actions.route == "db_commit"
    assert ctx.state["critic_result"]["status"] == "pass"
    assert "route_warning" in ctx.state["critic_result"]
    assert ctx.state["extractor_critiques"] == {}
    assert "missing_item" in capsys.readouterr().out


def test_route_critic_result_retries_known_failed_item_id():
    ctx = DummyContext(
        {
            "template_payload": {"items": [{"id": "assets", "name": "Assets"}]},
            "critic_output": json.dumps(
                {
                    "status": "fail",
                    "failed_item_id": "assets",
                    "critique": "Use the balance sheet value.",
                }
            ),
            "extractor_critiques": {},
        }
    )

    event = route_critic_result(ctx)

    assert event.actions.route == "retry_assets"
    assert ctx.state["extractor_critiques"] == {"assets": "Use the balance sheet value."}
