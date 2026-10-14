"""Run an unmodified Hermes Agent against the CI gateway fixture."""
import json
import os
from pathlib import Path

if os.environ.get("CI") != "true":
    raise RuntimeError("This harness check is restricted to CI")

from run_agent import AIAgent

path = Path(os.environ["GENAI_CI_FILE"])
original = path.read_text()
deltas = []
agent = AIAgent(
    base_url=os.environ["GENAI_CI_URL"], api_key="ci-hermes-key",
    provider="custom", api_mode="chat_completions",
    model=os.environ["GENAI_CI_MODEL"], max_iterations=5,
    max_tokens=1024, tool_delay=0, enabled_toolsets=["file"],
    quiet_mode=True, skip_memory=True, skip_context_files=True,
    persist_session=False, save_trajectories=False,
)
try:
    result = agent.run_conversation(
        f"Read {path} using read_file, update it using write_file, and report the result.",
        stream_callback=lambda delta: deltas.append(delta) if isinstance(delta, str) else None,
    )
    assert result.get("completed"), json.dumps(result, default=str)
    assert result.get("final_response") == "HERMES_OK", json.dumps(result, default=str)
    assert "HERMES_OK" in "".join(deltas), "Final response did not stream"
    assert path.read_text() == original + "_EDITED", "File was not updated"
    assert any(message.get("role") == "tool" and original in str(message.get("content"))
               for message in result.get("messages", [])), "Missing file-read result in history"
    print("HERMES_VERIFIED " + os.environ["GENAI_CI_MODEL"])
finally:
    agent.close()
