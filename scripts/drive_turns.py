"""Separate headless prompt turns."""
import json
import subprocess
import sys

claude_args, messages = sys.argv[1:-1], json.loads(sys.argv[-1])
with subprocess.Popen(claude_args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as child:
    for message in messages:
        child.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": message}}) + "\n")
        child.stdin.flush()
        for line in child.stdout:
            event = json.loads(line)
            if event.get("type") == "result":
                print(f">>> {message[:40]}\n{event.get('result', '')[:400]}", flush=True)
                break
    child.stdin.close()
    child.wait()
