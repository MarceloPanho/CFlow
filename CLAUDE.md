# CFlow — regras inegociáveis

App desktop pessoal que recebe código C++, transforma num fluxograma animado e mostra a execução real (via GDB) acendendo o caminho, ao lado de uma visualização ao vivo das estruturas de dados. Código, fluxograma e dados ficam sincronizados por uma única fonte de verdade: o trace da execução.

- **O trace é o contrato.** Motor e frontend só se comunicam pelo trace (JSON serializável). Estenda o schema de forma aditiva; nunca faça o frontend falar com o GDB nem o motor desenhar.
- **Motor ignora renderização; frontend ignora C++/GDB.**
- **Sempre compilar com `-O0 -g`** (sem otimização, com símbolos), senão a linha do GDB não bate com a linha do fluxograma.
- **Construa em fatias verticais.** Cada fase termina rodando de ponta a ponta, com um critério de "pronto" verificável, e é comitável isoladamente. Não avance de fase com a anterior quebrada.
- **Trabalhe uma fase por vez.** Ao fim de cada uma, rode o critério de aceite antes de seguir.
- **Portabilidade:** nada de path ou nome de binário hardcoded — toolchain e caminhos passam pela função de descoberta em `tracer.py` e por `pathlib`. No Windows, assumir MinGW (`g++`/`gdb`), nunca MSVC.
- Ao estender funcionalidade: primeiro o schema do trace, depois o tracer, depois o renderer.
