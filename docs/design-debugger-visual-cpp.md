# Debugger Visual de Algoritmos em C++ — Documento de Design

*Nome de trabalho — trocar quando quiser.*

## Visão geral

Um app desktop pessoal onde você cola código C++ e a ferramenta o transforma em um **fluxograma animado** que mostra a **execução real** do programa — o caminho acendendo conforme roda — ao lado de uma **visualização ao vivo das estruturas de dados** (arrays, pilhas, filas atualizando a cada modificação). Código, fluxograma e dados ficam sincronizados, todos movidos por uma única fonte de verdade: o trace da execução real capturado pelo GDB.

O objetivo final é amplo (programa inteiro, C++ completo), mas o projeto é construído em **fatias aditivas**: cada incremento roda de ponta a ponta e nada precisa ser reescrito para crescer.

## Princípios de design

Três decisões se reforçam e sustentam o resto:

1. **Fonte única de trace.** Tudo que anima na tela — o realce do fluxograma, o destaque da linha de código, a mudança nas estruturas — bebe de um único trace da execução. Isso é o que dá sincronia perfeita e reprodução (voltar, avançar, raspar) de graça.
2. **Desacoplamento total.** O motor (que entende o código e a execução) não sabe nada sobre desenho; os renderers não sabem nada sobre C++ ou GDB. A ponte entre eles é o trace, um dado serializável.
3. **O GDB é a verdade da execução.** Como o trace vem de rodar o código de verdade, a ferramenta depende pouco de análise estática profunda. Onde a semântica seria difícil (destrutores de RAII, métodos virtuais, recursão), o runtime simplesmente informa a linha real — e o fluxograma só precisa de um nó ali para acender.

## Arquitetura em camadas

### Motor (Python)

Python é o host/protagonista do app. Ele faz três coisas: parseia o C++, roda e rastreia a execução, e monta o CFG. Foi escolhido porque as duas partes difíceis (dirigir o GDB e montar o CFG) são mais limpas em Python, e porque compõe com o objetivo pessoal de investir na linguagem.

**Parsing e CFG — `tree-sitter-cpp`.** O parser é sintático, rápido e tolerante a erro (parseia código incompleto/quebrado numa boa, ótimo enquanto se digita), com dependência minúscula e intervalos de linha/coluna precisos por nó. A árvore sintática é caminhada para montar um **grafo de fluxo de controle (CFG) de blocos básicos**: sequências lineares de statements viram um único box, e só há ramificação nas decisões e loops (o losango de decisão, com a aresta de volta do loop formando o ciclo). Esse CFG *é* a estrutura do fluxograma.

O `libclang` foi descartado — ele entende semântica (tipos, RAII, virtuais), mas é pesado, mais lento e exige uma unidade de tradução completa (headers, flags) para parsear, o que atrita com trechos soltos. Não é usado no projeto; onde a semântica seria necessária, o runtime (GDB) cobre.

**Execução e trace — GDB, captura *eager* com teto.** O programa é compilado com `-O0 -g` (sem otimização, com símbolos) para que a linha reportada pelo GDB bata exatamente com a linha escrita. O GDB é dirigido programaticamente (API Python embutida do próprio GDB, ou `pygdbmi` por fora) e roda o programa **inteiro até o fim de uma vez**, gravando a cada passo um snapshot `(linha, variáveis, estado das estruturas)` numa lista.

A captura eager foi escolhida (em vez de lazy/sob demanda) porque torna toda a reprodução trivial: seek, voltar no tempo e play com velocidade viram apenas **mover um cursor sobre um array na memória**. O único risco — execução longa ou infinita — é contido por um **teto de passos**.

**Comportamento no teto (recurso, não erro).** Ao bater no teto, a ferramenta ainda renderiza tudo que capturou. Um loop infinito vira demonstração pedagógica: o token fica ciclando pela mesma aresta de trás, o rastro pulsa a cada volta e o contador de iterações sobe — o aluno *vê* por que não termina. O rótulo honesto é "bateu no teto (provável loop infinito)", já que provar terminação é o problema da parada. Exceção detectável com certeza: se um estado completo `(linha + todas as variáveis)` se repete idêntico, o loop é comprovadamente infinito.

### O trace (a ponte)

Uma lista imutável de snapshots. Cada entrada carrega a linha atual, as variáveis em escopo com seus valores, e o estado das estruturas de dados naquele instante. Por ser serializável, pode ser salvo, reproduzido e raspado sem re-rodar o código. É o contrato entre o motor e os renderers.

O campo de estruturas nasce **geral desde o início**: além de `kind:"array"/"stack"/"queue"` (carga plana), ele acomoda `kind:"graph"/"tree"` com `nodes` (cada um com endereço e campos) e `edges` (ponteiros). Assim o renderer box-and-pointer entra depois sem retrabalhar o contrato.

Animações de mudança saem de um **diff entre snapshots consecutivos**: `arr[2]` foi de 3 para 7 → aquela célula pisca; a pilha cresceu de 3 para 4 → anima um `push`; encolheu → um `pop`. O mesmo mecanismo (comparar antes/depois e traduzir em movimento) serve a todas as estruturas.

### Renderers (frontend JS)

O frontend é JS/HTML, confinado à única tarefa em que é imbatível: animar. Ele consome o trace e desenha duas vistas em sincronia.

**Fluxograma (fluxo de controle).** Layout dos nós via `dagre`/`elk`. A animação combina duas técnicas:

- **(A) base** — realce do nó/linha atual mais um rastro tingido do caminho já percorrido.
- **(B) toque nas ramificações** — um token luminoso fluindo pela aresta nas decisões e loops (tween de ~300ms), o que dá a sensação da decisão sendo tomada; num loop, o fluxo curva de volta ao topo e o rastro pulsando mostra a contagem de iterações. (Essa interpolação ao longo da aresta é a mesma ideia `(1-α)·a + α·b` do manim, aplicada ao traçado da seta.)

Estrutura em nível de bloco (legível), destaque de execução em nível de linha (dentro do bloco corrente). Câmera que segue (pan/zoom no nó ativo) fica para a fase do programa inteiro.

**Painel de dados (estruturas ao vivo).** Um segundo renderer, ao lado do fluxograma, consumindo o mesmo trace. Estratégia **(c) padrão inteligente**: promove automaticamente as estruturas reconhecidas a widgets ricos (via o tipo que o GDB informa) e lista os escalares num canto compacto — **mais** controle manual de mostrar/esconder em toda variável, para o usuário fixar um contador quando quiser ou esconder o que atrapalha. O painel é **por quadro de pilha**: mostra os locais do frame atual, então uma estrutura observada "some" ao entrar numa função e reaparece ao retornar.

Ordem de suporte das estruturas lineares: primeiro tipos da **STL** (auto-detecção pelo tipo — `vector`/array, depois `stack` e `queue`), depois as **implementações próprias/na mão** via um "observar variável como X" (apontar para o array com índice `top` e dizer que é uma pilha). Estruturas com ponteiros (lista encadeada, árvore, grafo) são atendidas pelo renderer box-and-pointer, descrito abaixo, que faz **parte do v1** (construído por último, por depender de todo o resto).

### Renderer box-and-pointer (structs, ponteiros, árvores, grafos)

Struct + ponteiro, lista encadeada, árvore e grafo são a **mesma coisa por baixo**: um diagrama box-and-pointer, onde um struct é uma caixa com campos e um campo do tipo ponteiro é uma seta para outra caixa. Por isso é **um renderer único** (não três), e "lista", "árvore" e "grafo" são apenas **modos de layout** sobre os mesmos dados de nós+arestas. Arquiteturalmente é o mesmo segundo renderer consumindo o trace, só que com carga em grafo em vez de array plano.

Pilares:

- **Identidade é o endereço de memória.** Cada nó é keyado pelo endereço — nó compartilhado é desenhado uma vez (com várias setas chegando) e ciclos não travam a travessia.
- **Travessia limitada a partir das raízes** (variáveis ponteiro/struct em escopo). Segue os campos-ponteiro (o GDB desreferencia e o tipo informa quais campos são ponteiros), marcando visitados. Ponteiro nulo vira destino explícito (o "null" clássico), não seta faltando.
- **Layout estável por endereço** — as posições persistem entre passos (nós existentes ficam onde estavam, com easing; só os novos são posicionados). É isso que faz uma inserção parecer "um nó nascendo na árvore" em vez de um desenho novo a cada quadro.
- **Diff por endereço** casa nós entre snapshots: campo mudou → pisca; endereço novo → nó surge; campo-ponteiro repontou → a seta migra; nó inalcançável → some. Rotação de árvore e inserção em lista caem naturalmente disso.
- **Modo de layout: auto-detecta + override.** Grafo genérico por padrão; layout hierárquico de árvore quando o grafo alcançável é acíclico e cada nó tem ≤1 pai; e um "observar como árvore/grafo/lista" para forçar. Caso conhecido que cai no override no v1: árvore com ponteiro para o pai (quebra a heurística "acíclico, um pai só"); heurística de aresta-inversa fica para depois.
- **Convenção de desenho:** campos de valor (`int`, struct por valor) desenham dentro da caixa; só campos-ponteiro viram seta.

**Visão lógica ⇄ estrutural.** As estruturas da STL (`std::map`, `std::set`, `std::list`) também são árvores/listas por dentro, mas os pretty-printers do GDB dão o conteúdo lógico (o `map` como pares chave→valor). São duas visões para públicos diferentes — quem usa vs. quem implementa —, então há um **toggle**: STL mostra o lógico por padrão, com opção de ver a fiação estrutural; struct+ponteiro cru é sempre estrutural.

**Semântica de ponteiros (C++).** Seguir ponteiro cru tem arestas que o modelo precisa tratar:

- **Inválido / dangling / não-inicializado** — antes de seguir, o tracer faz uma **leitura protegida** do endereço via GDB; se falhar (ilegível ou desalinhado ao tipo apontado), o destino é marcado `invalid` e desenhado como um sink "⚠ inválido". Ponteiro não-inicializado costuma conter lixo ilegível e cai nesse guard. Honestidade: dangling que aponta para memória liberada porém ainda legível nem sempre é detectável (parece válido) — gancho futuro é integrar ASan para pegar use-after-free com precisão. Mesmo assim, mostrar um ponteiro selvagem apontando para "inválido" é justamente o que aluno de C++ precisa ver.
- **`T*` que na verdade é array** — indecidível pelo ponteiro (um objeto? o primeiro de `new T[n]`?). Padrão: objeto único (um nó). Override: "observar como array[n]" informando o comprimento (valor ou variável). Caso especial: `char*` tratado como string (heurística de terminação em nulo).
- **`T**` (ponteiro de ponteiro)** — o modelo aplicado recursivamente: um nó cujo slot é ele mesmo um ponteiro (caixa com uma seta que aponta adiante). Sem caso especial.
- **Smart pointers** — o pretty-printer desembrulha o apontado, então vira uma seta normal; `shared_ptr` é o caso "nó compartilhado com várias setas" (dá para mostrar o refcount); `weak_ptr` como seta tracejada (não-dono). Enfeite adiável.
- **`void*` e ponteiro de função** — não há o que traversar: renderiza como um chip de endereço opaco rotulado. `void*` pode ganhar tipo via "observar como `T*`" e então ser seguido; ponteiro de função mostra o nome do símbolo (o GDB resolve endereço→função), não um nó de dados.
- **Ponteiro interior / aritmética** (`&arr[3]`, `p + 2`) — cai no meio de um objeto. Fallback: seta para o objeto/array que contém, com rótulo de deslocamento ("→ `arr[3]`"); quando o GDB não resolve o container, chip de endereço opaco.

Isso adiciona ao schema do trace: destino de aresta pode ser `addr | null | "invalid"`; nós/arestas carregam um `note` opcional (deslocamento, refcount, "opaco"); e `watch_as` cobre "array[n]" e o tipo de um `void*`.

### Casca (pywebview)

Arquitetura híbrida com **Python como host** e uma **webview** para o frontend, amarrados pelo `pywebview` — que usa a webview nativa do sistema (leve, sem embutir um navegador inteiro). O motor Python produz o trace e o CFG e os entrega ao JS; os botões de play/step chamam de volta o Python. O Electron foi descartado justamente porque inverteria os papéis (JS viraria host, Python um sidecar) e é a opção mais pesada.

### Portabilidade (Linux + Windows)

Alvo desde o início: os dois. Quase toda a diferença se concentra em dois pontos; o código Python e o frontend ficam iguais (`subprocess`/`pathlib` já abstraem separador de caminho e `gdb` vs `gdb.exe`).

- **Toolchain / GDB.** No Linux, `g++`/`gdb` nativos (via gerenciador de pacotes). No Windows não há GDB nativo — padroniza-se no **MinGW-w64 (MSYS2)**, que traz `g++` e `gdb` juntos. O MSVC (`cl.exe`) é descartado porque o GDB não o dirige bem (o debugger nativo é outro). Alternativa limpa: rodar sob **WSL**, que é o caminho Linux dentro do Windows. Decisão de design que evita retrabalho: a localização e o nome do compilador/gdb ficam atrás de uma função de descoberta no `tracer` — nunca hardcode.
- **Engine de webview.** O `pywebview` usa **WebView2** (Chromium/Edge) no Windows e **WebKitGTK** no Linux — motores diferentes, então o mesmo HTML/CSS/JS pode variar um pouco e o WebKitGTK às vezes fica atrás em recursos modernos. Como todo o frontend (fluxograma, animação) mora ali, é onde surpresa aparece: testar a animação nos dois. Se o WebKitGTK incomodar, o backend **Qt (QtWebEngine)** no Linux é Chromium e dá paridade de engine.
- **Empacotamento.** Não há cross-compile: gera-se o binário Linux no Linux e o `.exe` no Windows (PyInstaller e afins rodam por-plataforma). Usuário de Windows não tem `gdb`/`g++`, então ou se **empacota o MinGW junto** (instalador maior) ou se exige a instalação; no Windows ainda pode ser preciso assinar o código (SmartScreen). Os instaladores por-plataforma são o **passo final do v1** (ver escopo do v1).

## Layout e UX

Duas partes principais de **primeira classe**, fluxograma e código-fonte, separadas por um **divisor redimensionável** (arrastável). O fluxograma é o protagonista; o código é uma metade co-igual, não uma faixa lateral.

- **Painel de dados** — terceira região redimensionável encaixada **embaixo do painel do fluxograma** (podendo ser destacável/ocultável); as estruturas pertencem visualmente ao lado animado.
- **Timeline + controles** — barra fina no **rodapé**, atravessando a largura toda: step para frente e para trás, play com velocidade, e um **scrubber** que raspa toda a execução como um vídeo (possível porque o trace eager já está inteiro na memória).

**Dois modos de uso.** *Modo edição*: um editor onde você cola/escreve o código e aperta "Rodar". *Modo visualização*: durante a execução o código entra em só-leitura e suas linhas acendem em sincronia com os nós do fluxograma. Alterna-se entre os dois.

**Sincronia.** Um "passo" avança o realce do fluxograma, o destaque da linha no código e a animação do painel de dados no mesmo instante — "essa linha rodou → o array mudou → a pilha cresceu" como uma batida coordenada só.

## Comportamentos específicos

**Chamadas de função.** Padrão **passar-por-cima** (`next` do GDB): a chamada é um nó que acende e você vê o efeito dela sem sair do fluxograma atual. **Entrar** (`step`) é uma ação explícita (botão "step into") que troca a vista para o fluxograma da função chamada e empilha um quadro numa **trilha de pilha de chamadas**; ao retornar, desempilha. **Recursão sai de graça** desse modelo — a pilha cresce a cada chamada e desempilha no retorno, que é justamente o mais difícil de visualizar sobre recursão.

**Árvore de recursão.** Além da pilha linear, o v1 traz uma visão de **árvore de chamadas** (alternável com a pilha): um nó por invocação recursiva, rotulado com os argumentos e, no retorno, com o valor devolvido, ramificando pai→filho. É a visão mais reveladora para recursão em árvore (fibonacci ingênuo, backtracking, divide-and-conquer). Ela **reusa o renderer box-and-pointer** — os nós vêm dos eventos de chamada/retorno já presentes no trace, alimentando o mesmo layout de árvore, animação e diff, em vez de nós do heap.

## Escopo do v1 (a primeira fatia)

O menor recorte que já se parece com o produto final:

- **Uma função por vez.**
- **Construtos de fluxo:** sequência (bloco básico), `if`/`else`, `for`/`while`, `switch`, `break`/`continue`, ternário, chamada de função (como nó em que dá para entrar) e `return`.
- **Execução real** via GDB animando o fluxograma.
- **Entrada:** o usuário cola um programa completo com `main()` que monta os dados e chama a função; a ferramenta compila e roda o que veio, sem gerar arnês.
- **Dados:** começa com **array/vector** (STL); pilha e fila logo em seguida pelo mesmo padrão; e o **"observar variável como X"** para as estruturas lineares na mão (apontar para o array com índice `top` e dizer que é uma pilha).
- **Renderer box-and-pointer** (structs, ponteiros, listas, árvores, grafos), com o tratamento de semântica de ponteiros descrito acima. É a **última peça de funcionalidade dentro do v1**, por depender de todo o resto já rodando.
- **Árvore de recursão** — visão de árvore de chamadas (alternável com a pilha linear), reusando o renderer box-and-pointer.
- **Empacotamento:** instaladores por-plataforma (Linux e Windows), com o MinGW empacotado ou exigido. Passo **final** do v1 — feito depois de tudo funcionar.

## O que ficou explicitamente para depois (aditivo)

Nada aqui exige rearquitetura — tudo pluga no que o v1 já roda:

- Demais construtos de fluxo: `goto`, exceções (`try`/`catch`/`throw`).
- Múltiplas funções na mesma tela e ponteiros de função/virtuais.
- Formulário de entrada que gera um `main` automático a partir da assinatura (tipos simples: `int`, `vector`, `string`, arrays) — evoluir para o modelo híbrido.
- Heurística de aresta-inversa para árvores com ponteiro pro pai; integração com ASan para detectar dangling/use-after-free com precisão.
- Câmera que segue (pan/zoom) para fluxogramas grandes.
- Janela/amostragem do trace para execuções muito longas.

## Pilha técnica (resumo)

- **Motor:** Python.
- **Parsing/CFG:** `tree-sitter-cpp`.
- **Execução/trace:** GDB (API Python do GDB ou `pygdbmi`), compilando com `-O0 -g`.
- **Casca:** `pywebview` (webview nativa).
- **Frontend/animação:** JS/HTML, com `dagre`/`elk` para layout de grafo.

## Ordem de construção sugerida

1. Motor mínimo: compilar + rodar sob GDB + capturar o trace eager de uma função simples (só sequência e um `if`).
2. Fluxograma estático a partir do CFG (tree-sitter → blocos básicos → layout).
3. Ligar trace ao fluxograma: realce da linha/nó atual, controles de step.
4. Animação (A + B) e o scrubber da timeline.
5. Painel de dados com `vector`/array (diff → animação).
6. Loops e a demonstração de loop infinito no teto.
7. Pilha e fila (STL); step-into + trilha de pilha de chamadas.
8. Daí em diante, os itens aditivos, um por vez.
