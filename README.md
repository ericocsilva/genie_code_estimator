# Estimador de custo de Genie Code — Databricks App

Aplicação para estimar o consumo e o custo de Genie Code em novos projetos, com duas visões:

- **Sizing rápido** — 4 perguntas (nº de pessoas, perfil de uso, duração, automações) que resultam em uma faixa de custo e na classificação P / M / G.
- **Deep dive** — estimativa detalhada por persona, com queries SQL para calibrar as premissas a partir do consumo real do workspace.

Todo o cálculo é feito no navegador. O backend (FastAPI) apenas serve os arquivos estáticos — o app **não** lê nem grava dados no workspace e não precisa de SQL Warehouse, secrets ou outros recursos.

## Estrutura

```
app.py            # backend FastAPI (serve o frontend)
app.yaml          # comando de execução do Databricks App
requirements.txt  # dependências Python
static/           # frontend (HTML, JS, CSS)
```

## Pré-requisitos

- Workspace com **Databricks Apps** habilitado.
- Permissão para criar apps no workspace.
- (Opcional) [Databricks CLI](https://docs.databricks.com/dev-tools/cli/install.html) v0.250+ autenticada no workspace.

## Instalação

### Opção A — Databricks CLI

```bash
# 1. Enviar o código para o workspace
databricks workspace import-dir ./genie_code_estimator /Workspace/Shared/genie-code-estimator

# 2. Criar o app
databricks apps create genie-code-estimator

# 3. Fazer o deploy
databricks apps deploy genie-code-estimator \
  --source-code-path /Workspace/Shared/genie-code-estimator
```

Para atualizar depois de alterar o código, repita os passos 1 (com `--overwrite`) e 3.

### Opção B — Interface do workspace

1. Em **Workspace**, crie a pasta `/Workspace/Shared/genie-code-estimator` e faça upload dos arquivos (mantendo a pasta `static/`).
2. Vá em **Compute → Apps → Create app → Custom**, informe o nome `genie-code-estimator` e crie o app.
3. Clique em **Deploy** e selecione a pasta do passo 1.
4. Ao final do deploy, a URL do app aparece na página do app.

## Acesso

Na página do app, em **Permissions**, conceda `CAN USE` aos usuários ou grupos que vão utilizar o estimador.

## Calibrando as premissas

As premissas padrão de DBU por sessão são **referências iniciais**. Para estimativas mais precisas:

1. Abra o **Deep dive** e copie a **Query 1** (DBU de Genie Code por usuário/mês).
2. Rode a query em um SQL Warehouse com acesso a `system.billing.usage`.
3. Preencha os percentis observados no app.

Se não houver histórico comparável, recomenda-se um piloto de 14 a 30 dias com um time representativo.

## Custos de operação

O app roda em compute serverless do Databricks Apps e consome enquanto estiver ativo. Quando não estiver em uso, ele pode ser parado na página do app (**Stop**).
