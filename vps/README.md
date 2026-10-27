# Evolution API na VPS

Na VPS (Ubuntu/Debian, como root), rode:

    curl -fsSL https://raw.githubusercontent.com/WoodAllem-IA/cashday/main/vps/instalar.sh | bash

O instalador coloca Docker, Evolution API, banco de dados e HTTPS automático (endereço grátis `IP.sslip.io`).
No final ele mostra o endereço do painel e a chave. As portas 80 e 443 precisam estar livres.
