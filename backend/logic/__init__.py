r"""
cd D:\WhenWhere
.\venv\Scripts\Activate.ps1
uvicorn backend.app:app --reload

Then open http://127.0.0.1:8000/ -- the FastAPI app serves the frontend
directly, so no separate static file server is needed.
"""