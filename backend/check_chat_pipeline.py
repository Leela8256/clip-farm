"""
Verification script for .rocketride/chat_editor.pipe — confirms the pipeline
loads and the agent responds, per RocketRide's mandated check.py convention.
Run with: docker compose exec api python check_chat_pipeline.py
"""

from __future__ import annotations
import asyncio
import os

from rocketride import RocketRideClient
from rocketride.schema import Question

PIPE_PATH = os.getenv(
    "CHAT_PIPE_PATH",
    os.path.join(os.path.dirname(__file__), "..", ".rocketride", "chat_editor.pipe"),
)


async def main():
    client = RocketRideClient(
        uri=os.environ["ROCKETRIDE_URI"], auth=os.environ["ROCKETRIDE_APIKEY"]
    )
    try:
        await client.connect()
        print("connected to RocketRide engine")

        result = await client.use(filepath=PIPE_PATH, use_existing=True)
        token = result["token"]
        print(f"pipeline started, token={token}")

        question = Question()
        question.addContext("Job ID: test-job-000")
        question.addQuestion("Say hello and tell me what tools you have access to.")

        response = await client.chat(token=token, question=question)
        print("response:", response)
    finally:
        await client.disconnect()


asyncio.run(main())
