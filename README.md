# CFlow

App desktop pessoal que recebe código C++, monta um **fluxograma** do fluxo de controle e mostra a **execução real** capturada pelo GDB: o caminho acende, a linha do código acompanha, e as estruturas de dados mudam no mesmo passo.

Código, fluxograma e painel de dados compartilham uma única fonte de verdade — o **trace** da execução.

## Requisitos

- Python 3.10+
- `g++` e `gdb` no `PATH`
  - Linux: pacotes nativos (`g++`, `gdb`)
  - Windows: **MinGW-w64 via MSYS2** (`g++`/`gdb`). Não usar MSVC/`cl.exe`.
- Linux: GTK + WebKit (`gir1.2-webkit2-4.1`, `python3-gi`) para o `pywebview`
- Crie o venv com acesso aos pacotes do sistema no Linux: `python3 -m venv --system-site-packages .venv`

## Instalação

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Uso

```bash
python engine/app.py
```

1. Escolha um sample (ou cole um programa C++ completo com `main`).
2. Ajuste o teto de passos e se o depurador deve **entrar em chamadas**.
3. Clique em **Rodar**. O motor compila com `-O0 -g`, captura o trace e entrega CFG + trace ao frontend.
4. Use passo a passo, play e o scrubber da timeline. Botão direito numa variável: **observar como** pilha/fila/árvore/array.

## Testes

```bash
.venv/bin/pytest -q
```

## Empacotamento

Build por plataforma (sem cross-compile):

```bash
.venv/bin/pyinstaller pack/cflow.spec
```

No Windows, empacote o MinGW (`g++`/`gdb`) junto ou exija-o na primeira execução.
