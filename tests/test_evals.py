import json

from server.routes.evals import _gemini_tuning_record, _json_line, _openai_chat_record


def test_openai_chat_record_maps_template_context_and_corrected_value():
    row = {
        "field_id": "rating_action",
        "input_context_chunk": "The issuer rating was affirmed after review.",
        "corrected_value": {"value": "Affirmed"},
        "template_config": {
            "items": [
                {
                    "id": "rating_action",
                    "definition": "Extract the final rating action.",
                }
            ]
        },
    }

    record = _openai_chat_record(row)

    assert record == {
        "messages": [
            {"role": "system", "content": "Extract the final rating action."},
            {"role": "user", "content": "The issuer rating was affirmed after review."},
            {"role": "assistant", "content": '{"value": "Affirmed"}'},
        ]
    }


def test_gemini_tuning_record_maps_to_contents_and_system_instruction():
    row = {
        "field_id": "capital_ratio",
        "input_context_chunk": "Capital ratio increased to 12.5%.",
        "corrected_value": "12.5%",
        "template_config": {"fields": [{"id": "capital_ratio", "description": "Extract the capital ratio."}]},
    }

    record = _gemini_tuning_record(row)

    assert record["systemInstruction"]["parts"][0]["text"] == "Extract the capital ratio."
    assert record["contents"] == [
        {"role": "user", "parts": [{"text": "Capital ratio increased to 12.5%."}]},
        {"role": "model", "parts": [{"text": "12.5%"}]},
    ]


def test_json_line_serializes_as_single_jsonl_record():
    line = _json_line({"messages": [{"role": "assistant", "content": "Approved"}]})

    assert line.endswith("\n")
    assert json.loads(line) == {"messages": [{"role": "assistant", "content": "Approved"}]}
