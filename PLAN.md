# Plano de Implementação — Debugger Visual de Algoritmos em C++

*Plano de execução para o Claude Code. O raciocínio e o "porquê" de cada decisão estão no documento de design; aqui é o "como", em fases construíveis e verificáveis.*

## Contexto para o agente

Estamos construindo um app desktop pessoal que recebe código C++, o transforma num **fluxograma animado** e mostra a **execução real** (via GDB) acendendo o caminho, ao lado de uma **visualização ao vivo das estruturas de dados**. Código, fluxograma e dados ficam sincronizados por uma **única fonte de verdade: o trace da execução**.

Regras inegociáveis do projeto (tratar como `CLAUDE.md`):

- **O trace é o contrato.** Motor e frontend só se comunicam pelo trace (JSON serializável). Estenda o schema de forma aditiva; nunca faça o frontend falar com o GDB nem o motor desenhar.
- **Motor ignora renderização; frontend ignora C++/GDB.**
- **Sempre compilar com `-O0 -g`** (sem otimização, com símbolos), senão a linha do GDB não bate com a linha do fluxograma.
- **Construa em fatias verticais.** Cada fase termina rodando de ponta a ponta, com um critério de "pronto" verificável, e é comitável isoladamente. Não avance de fase com a anterior quebrada.
- **Trabalhe uma fase por vez.** Ao fim de cada uma, rode o critério de aceite antes de seguir.

## Stack

- **Motor:** Python.
- **Parsing/CFG:** `tree-sitter` + gramática `tree-sitter-cpp`.
- **Execução/trace:** GDB, dirigido pela API Python do GDB ou por `pygdbmi`.
- **Casca:** `pywebview` (host Python, webview nativa; frontend só renderiza).
- **Frontend:** JS/HTML, layout de grafo com `dagre` ou `elk`.

**Portabilidade (Linux + Windows, alvo desde o início).** O código Python e o frontend ficam iguais nos dois; a diferença mora em dois pontos:

- **Toolchain:** `g++`/`gdb` no PATH. No Linux, nativos (gerenciador de pacotes). No Windows, via **MinGW-w64 (MSYS2)** — nunca MSVC/`cl.exe` (o GDB não o dirige). WSL é alternativa. **Regra:** a descoberta do compilador/gdb (caminho, nome, sufixo `.exe`) fica atrás de uma função no `tracer.py`; nada de path hardcoded.
- **Webview:** o `pywebview` usa WebView2 (Chromium) no Windows e WebKitGTK no Linux — testar a animação nos dois; `QtWebEngine` é opção no Linux para paridade de engine.
- **Empacotamento:** sem cross-compile — build por-plataforma (PyInstaller em cada SO); usuário Windows não tem toolchain, então empacotar o MinGW ou exigir instalação. É a **Fase 11**, passo final do v1.

## Estrutura de repositório sugerida

```
engine/
  app.py        # host pywebview; expõe API ao JS
  parser.py     # tree-sitter -> AST walk
  cfg.py        # modelo de blocos básicos; monta o CFG
  tracer.py     # compila, dirige o GDB, captura o trace
  trace.py      # schema e (de)serialização do trace
frontend/
  index.html
  bridge.js     # chamadas para o Python (js_api)
  flowchart.js  # render do CFG + animação (dagre/elk)
  datapanel.js  # widgets de array/pilha/fila + diff->animação
  player.js     # cursor sobre o trace; controles; scrubber
samples/        # programas C++ de teste
CLAUDE.md
PLAN.md         # este arquivo
README.md       # apresentação do projeto: o que é, requisitos, instalação, uso
```

## Contratos (schemas)

Definir cedo e construir contra eles.

**Trace** (saída do `tracer.py`):

```json
{
  "function": "bubbleSort",
  "cap": 100000,
  "hit_cap": false,
  "steps": [
    {
      "i": 0,
      "line": 7,
      "func": "bubbleSort",
      "stack_depth": 1,
      "scalars": { "i": 0, "j": 0, "n": 5 },
      "structures": {
        "arr":  { "kind": "array", "values": [3, 1, 2, 5, 4] },
        "root": {
          "kind": "tree",
          "layout_hint": null,
          "nodes": [
            { "addr": "0x55a1", "fields": { "val": 5 } },
            { "addr": "0x55b2", "fields": { "val": 3 } }
          ],
          "edges": [
            { "from": "0x55a1", "field": "left",  "to": "0x55b2" },
            { "from": "0x55a1", "field": "right", "to": null }
          ]
        }
      }
    }
  ]
}
```

`kind` das estruturas: `"array"`, `"stack"`, `"queue"` (lineares) e `"graph"`/`"tree"` (box-and-pointer: `nodes` com `addr`+`fields`, `edges` de ponteiro). **Desenhe o campo `structures` já geral assim desde a Fase 1**, mesmo que só o `array` seja preenchido no começo — o renderer de grafo (Fase 9) entra sem mexer no contrato. Destino de aresta (`to`): um `addr`, `null` (ponteiro nulo) ou `"invalid"` (endereço ilegível — ponteiro selvagem/dangling). Nós e arestas aceitam um `note` opcional (deslocamento, refcount, "opaco"). `layout_hint` (`null` = auto-detecta; `"tree"`/`"graph"`/`"list"` = override). `watch_as` cobre o override do usuário para casos indecidíveis (`"array[n]"` para um `T*` que é array; tipo para um `void*`).

**CFG** (saída do `cfg.py`):

```json
{
  "function": "bubbleSort",
  "nodes": [
    { "id": "b0", "kind": "block",    "lines": [3, 4], "label": "int i = 0; ..." },
    { "id": "d1", "kind": "decision", "lines": [5],    "label": "j < n-1" },
    { "id": "b2", "kind": "block",    "lines": [6, 7], "label": "swap(...)" },
    { "id": "r1", "kind": "return",   "lines": [9],    "label": "return" }
  ],
  "edges": [
    { "from": "b0", "to": "d1" },
    { "from": "d1", "to": "b2", "label": "true"  },
    { "from": "d1", "to": "r1", "label": "false" },
    { "from": "b2", "to": "d1" }
  ]
}
```

Cada nó carrega o intervalo de linhas; é isso que liga `step.line` -> nó a acender.

## Fases

### Fase 0 — Setup e esqueleto
- Inicializar repo, venv, instalar deps (`tree_sitter`, gramática cpp, `pygdbmi`, `pywebview`); frontend com `dagre`/`elk` vendorizados.
- **Descoberta de toolchain:** função no `tracer.py` que localiza `g++`/`gdb` (com sufixo `.exe` no Windows, MinGW no PATH), sem hardcode; verificar nos dois SOs alvo.
- Criar a estrutura de pastas e o `CLAUDE.md` com as regras acima, e o `README.md` (apresentação, requisitos, instalação por-plataforma e uso).
- Adicionar 3 samples: soma num loop, bubble sort, fatorial recursivo.

**Pronto quando:** `python engine/app.py` abre uma janela pywebview vazia (validada em Linux e Windows); um smoke test confirma que o tree-sitter parseia um sample e o GDB consegue lançar um binário compilado em ambos.

### Fase 1 — Motor mínimo: o trace
- `trace.py`: implementar o schema do trace.
- `tracer.py`: compilar um sample com `g++ -O0 -g`, dirigir o GDB para dar `step` linha a linha até o fim (respeitando um teto de passos), capturando por passo `line`, `func`, `stack_depth` e `scalars`. (Estruturas ficam para a Fase 6.)
- Emitir o trace como JSON.

**Pronto quando:** rodar o tracer no sample de soma produz um trace cuja sequência de linhas bate com a execução conferida à mão; o teto é respeitado.

### Fase 2 — CFG estático
- `parser.py` + `cfg.py`: parsear uma função com tree-sitter e montar o CFG de blocos básicos para os construtos do v1: sequência, `if`/`else`, `for`/`while`, chamada como nó, `return`, além de `switch` (nó multi-saída, com fallthrough como arestas entre `case`s), `break`/`continue` (arestas para saída/cabeçalho do loop) e ternário `?:` (ramificação de sub-expressão). Emitir o CFG JSON com intervalos de linha por nó. Sugestão de ordem interna: monte primeiro o mínimo (`if` + loop) para destravar as fases seguintes, e adicione `switch`/`break`/`continue`/ternário logo depois.

**Pronto quando:** o CFG do bubble sort tem os blocos certos, os nós de decisão e a aresta de volta do loop; cada nó mapeia para os intervalos de linha corretos.

### Fase 3 — Frontend shell + fluxograma estático
- `app.py`: expor via `js_api` do pywebview métodos que devolvem o CFG JSON e o trace JSON.
- `flowchart.js`: renderizar o CFG com `dagre`/`elk` — caixas para blocos, losangos para decisões, setas incluindo a de volta do loop.

**Pronto quando:** abrir o app mostra o fluxograma do bubble sort, legível e bem posicionado (ainda sem execução).

### Fase 4 — Ligar o trace ao fluxograma (o coração)
- `player.js`: cursor sobre `trace.steps`; mapear `step.line` -> nó do CFG (pelos intervalos de linha) -> realce; realçar também a linha no painel de código.
- Controles de step para frente/trás (cursor ±1, trivial sobre a lista eager).
- Painel de código em modo só-leitura ("visualização") com a linha atual destacada.

**Pronto quando:** dar step avança o realce pelo fluxograma e pelo código em sincronia, para frente e para trás, batendo com o trace.

### Fase 5 — Animação + timeline
- Transição do realce entre nós: (A) rastro tingido no caminho percorrido; (B) token com tween de ~300ms fluindo pela aresta nas decisões/loops.
- Barra de rodapé: play/pause + velocidade; scrubber buscando qualquer ponto do trace.

**Pronto quando:** o play anima a execução suavemente; o scrubber pula para qualquer ponto; no loop o token curva de volta e o rastro pulsa a cada volta.

### Fase 6 — Painel de dados (array/vector)
- Estender o `tracer.py` para capturar estruturas: ler o conteúdo de `vector`/array a cada passo (pretty-printers/introspecção do GDB) e preencher `step.structures`.
- `datapanel.js`: renderizar array como fileira de caixas; diff entre passos consecutivos -> piscar células alteradas, animar crescimento/encolhimento.
- Padrão inteligente de visibilidade + toggle de mostrar/esconder por variável; escalares num canto compacto.

**Pronto quando:** rodar o bubble sort mostra o array em caixas, com células piscando/trocando em sincronia com cada passo.

### Fase 7 — Loops e teto / loop infinito
- Garantir o teto de passos no tracer; setar `hit_cap`; preservar o trace parcial.
- Frontend: com `hit_cap`, ainda reproduzir; rotular "provável loop infinito"; detectar recorrência de estado idêntico (`linha` + todas as variáveis) -> "loop infinito comprovado".

**Pronto quando:** um sample de loop infinito bate no teto, ainda anima o ciclo e mostra o rótulo certo.

### Fase 8 — Pilha, fila, step-into e pilha de chamadas
- Widgets de `stack` e `queue` com push/pop e enqueue/dequeue (detecção por tipo + diff).
- **"Observar variável como X" para estruturas lineares na mão:** o usuário aponta para uma implementação própria (ex.: array + índice `top`) e diz que é uma pilha/fila; o `watch_as` no trace passa a tratá-la com o widget correspondente.
- Step-into (GDB `step`) alternando a função exibida; trilha de pilha de chamadas; painel de dados por quadro de pilha (escalares/estruturas do frame atual).
- Validar recursão com o sample de fatorial (pilha crescendo/desempilhando).

**Pronto quando:** o fatorial mostra a trilha da pilha crescendo na recursão; um sample com pilha anima push/pop.

### Fase 9 — Renderer box-and-pointer (structs, ponteiros, árvores, grafos)
Última **fase de funcionalidade** do v1, construída por depender de todas as fases anteriores.

- **Tracer:** a partir das raízes ponteiro/struct em escopo, traversar o heap via GDB (desreferenciar campos-ponteiro; o tipo diz quais campos seguir), marcando visitados **por endereço**; emitir `kind:"graph"/"tree"` com `nodes` (`addr`+`fields`) e `edges` (ponteiro; `to:null` para nulo). Limitar a travessia às raízes alcançáveis.
- **Guard de ponteiro (crítico, faça primeiro):** antes de seguir qualquer ponteiro, tentar uma **leitura protegida** do endereço via GDB; se falhar (ilegível/desalinhado), emitir a aresta com `to:"invalid"` — nunca seguir cegamente lixo. O renderer desenha um sink "⚠ inválido". (Pega ponteiro não-inicializado e a maioria dos dangling; dangling legível pode escapar — futuro: ASan.)
- **Renderer:** desenhar cada nó como caixa (campos de valor dentro, campos-ponteiro como seta); nó por endereço (compartilhado desenhado uma vez). **Layout estável por endereço** — persistir posições entre passos, só posicionar nós novos, com easing nos existentes (sem isso a animação não lê).
- **Modos de layout:** auto-detecta (acíclico + ≤1 pai → árvore hierárquica; senão grafo genérico) + override "observar como árvore/grafo/lista" (`layout_hint`). Árvore com ponteiro pro pai usa o override.
- **Diff por endereço:** inserção (nó/aresta novos), repontar (aresta migra), campo alterado (pisca), nó inalcançável (some).
- **Casos de ponteiro a cobrir:** `T*`-que-é-array → padrão objeto único, `watch_as:"array[n]"` para informar comprimento (`char*` como string por heurística); `T**` → recursivo (nó cujo slot é ponteiro), sem caso especial; smart pointers → pretty-printer desembrulha (seta normal; refcount no `shared_ptr`; tracejada no `weak_ptr`); `void*`/ponteiro de função → chip de endereço opaco rotulado (void* seguível só com `watch_as` de tipo; ponteiro de função mostra o símbolo); ponteiro interior/aritmética → seta pro container com `note` de deslocamento.
- **Toggle lógico ⇄ estrutural** para STL (`std::map`/`set`/`list`): lógico por padrão (pretty-printer), estrutural mostra a fiação.

**Pronto quando:** um sample de árvore binária (inserção) mostra os nós como caixas com setas `left`/`right`, layout de árvore automático, e a inserção anima um nó surgindo com layout estável; um sample de grafo com ciclo renderiza sem travar, cada nó uma vez; um sample com ponteiro inválido mostra o sink "⚠ inválido" sem quebrar a travessia.

### Fase 10 — Árvore de recursão
Depende da Fase 9 (reusa o renderer de grafo/árvore) e da Fase 8 (dados de chamada/retorno na pilha).

- Detectar recursão (a mesma função aparecendo mais de uma vez na pilha) e construir uma **árvore de chamadas**: um nó por invocação, rotulado com os argumentos e, no retorno, com o valor devolvido; aresta pai→filho ligando quem chamou a quem foi chamado.
- Derivar os nós/arestas dos **eventos de chamada/retorno já presentes no trace** (`func` + `stack_depth` + argumentos por passo) — sem nova fonte de dados.
- **Reusar o renderer da Fase 9** (layout de árvore, layout estável, animação, diff): o nó nasce quando a chamada acontece, o retorno preenche/colore o nó, ramos irmãos surgem conforme executam.
- Visão alternável: **pilha linear** (Fase 8) ⇄ **árvore de recursão**.

**Pronto quando:** um sample de fibonacci ingênuo (`fib(5)`) mostra a árvore de chamadas crescendo — cada invocação um nó rotulado com o argumento, ramificando em duas chamadas, e o retorno preenchendo o valor de volta.

### Fase 11 — Empacotamento (Linux + Windows) — *fecha o v1*
Passo final, feito depois de tudo funcionar.

- Build por-plataforma com PyInstaller (ou equivalente): binário Linux no Linux, `.exe` no Windows (sem cross-compile).
- Resolver o toolchain no destino: **empacotar o MinGW (`g++`/`gdb`) junto** do instalador Windows, ou exigi-lo com verificação clara na primeira execução; no Linux, declarar/instalar via dependência de pacote.
- Validar que o app empacotado roda numa máquina limpa (sem o ambiente de dev) nos dois SOs; no Windows, avaliar assinatura de código para o SmartScreen.

**Pronto quando:** instaladores gerados para Linux e Windows rodam o app numa máquina sem toolchain de dev e conseguem compilar+traçar um sample. **Com isso o v1 está completo.**

## Backlog aditivo (pós-v1)

Nada aqui exige rearquitetura — tudo pluga no trace existente: `goto` e exceções (`try`/`catch`/`throw`); múltiplas funções na tela e ponteiros de função/virtuais; formulário de entrada que gera `main` automático (tipos simples); câmera que segue (pan/zoom); janela/amostragem do trace para execuções longas; heurística de aresta-inversa para árvores com ponteiro pro pai; integração com ASan para dangling/use-after-free preciso.

## Notas de trabalho para o agente

- Comece pela Fase 0 e não pule etapas; cada fase deve rodar e ser comitada antes da próxima.
- O trabalho pesado mora no Python; o frontend só consome o trace e desenha.
- Ao estender funcionalidade, primeiro estenda o schema do trace, depois o tracer, depois o renderer — nessa ordem.
- Mantenha os samples como testes de fumaça vivos: toda fase deve continuar funcionando neles.
- **Portabilidade:** nada de path ou nome de binário hardcoded — toolchain e caminhos passam pela função de descoberta e por `pathlib`. No Windows, assumir MinGW (`g++`/`gdb`), nunca MSVC. Quando possível, validar cada fase em Linux e Windows (ou WSL).
