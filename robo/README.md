# Robô do CashDay

Manda as cobranças do dia pelo WhatsApp no horário escolhido no app.
Roda grátis na Cloudflare: verifica a cada 2 minutos e envia uma mensagem por vez.
Envia pela **Evolution API** na sua VPS (veja `../vps`) ou, se preferir, pela Z-API.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/WoodAllem-IA/cashday/tree/main/robo)

Segredos (Settings > Variables and Secrets do Worker):

| Nome | O que é |
|---|---|
| `SENHA_ROBO` | Senha que você inventa e coloca também no app (Ajustes) |
| `EVOLUTION_URL` | Endereço da Evolution (o instalador da VPS mostra, ex.: `https://1-2-3-4.sslip.io`) |
| `EVOLUTION_APIKEY` | Chave da Evolution (o instalador mostra) |
| `EVOLUTION_INSTANCIA` | Nome da instância criada no painel da Evolution (ex.: `cashday`) |
| `ZAPI_INSTANCIA`, `ZAPI_TOKEN`, `ZAPI_CLIENT_TOKEN` | Só se usar Z-API em vez da Evolution |
