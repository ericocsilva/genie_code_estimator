"""Estimador de custo de Genie Code — Databricks App.

Backend mínimo: serve o frontend estático. Todo o cálculo roda no navegador,
para que cliente e time Databricks preencham juntos sem depender de dados
persistidos no workspace (estimativas são salvas/carregadas como JSON).
"""
import os

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

app = FastAPI(title="Genie Code Cost Estimator")


@app.get("/api/health")
def health():
    return {"status": "ok"}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))
