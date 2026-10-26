# Robô do CashDay

Manda as cobranças do dia pelo WhatsApp (via Z-API) no horário escolhido no app.
Roda grátis na Cloudflare: verifica a cada 2 minutos e envia uma mensagem por vez.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/WoodAllem-IA/cashday/tree/main/robo)

Segredos (Settings > Variables and Secrets do Worker):

| Nome | O que é |
|---|---|
| `SENHA_ROBO` | Senha que você inventa e coloca também no app (Ajustes) |
| `ZAPI_INSTANCIA` | ID da instância na Z-API |
| `ZAPI_TOKEN` | Token da instância na Z-API |
| `ZAPI_CLIENT_TOKEN` | Token de segurança da conta Z-API (se estiver ativado) |
