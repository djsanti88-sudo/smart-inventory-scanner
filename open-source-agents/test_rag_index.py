import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("rag-index.py")
SPEC = importlib.util.spec_from_file_location("rag_index", MODULE_PATH)
rag_index = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(rag_index)


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class RagIndexLmStudioContractTest(unittest.TestCase):
    def test_resolves_nomic_model_from_openai_compatible_models_endpoint(self):
        payload = {
            "data": [
                {"id": "qwen/qwen3-8b"},
                {"id": "text-embedding-nomic-embed-text-v1.5"},
            ]
        }

        with patch.object(
            rag_index.urllib.request,
            "urlopen",
            return_value=FakeResponse(payload),
        ) as request:
            model = rag_index.resolve_embed_model()

        self.assertEqual(model, "text-embedding-nomic-embed-text-v1.5")
        self.assertEqual(request.call_args.args[0], "http://localhost:1234/v1/models")

    def test_reads_embeddings_from_openai_compatible_response(self):
        with patch.object(
            rag_index,
            "post_json",
            return_value={
                "data": [
                    {"index": 1, "embedding": [3.0, 4.0]},
                    {"index": 0, "embedding": [1.0, 2.0]},
                ]
            },
        ) as post:
            vectors = rag_index.embed("nomic-model", ["first", "second"])

        self.assertEqual(vectors, [[1.0, 2.0], [3.0, 4.0]])
        post.assert_called_once_with(
            "/embeddings",
            {"model": "nomic-model", "input": ["first", "second"]},
        )


if __name__ == "__main__":
    unittest.main()
