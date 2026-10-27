# Servidor do CashDay (Railway)

Guarda os dados no Postgres (com backups automáticos), guarda fotos e documentos
e roda o robô de cobrança pela Evolution API.

1. Railway: New Project > Deploy from GitHub repo > `WoodAllem-IA/cashday`.
2. No projeto: Create > Database > PostgreSQL.
3. No serviço `cashday` > Variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `APP_SENHA` = a senha para entrar no app
   - `EVOLUTION_URL`, `EVOLUTION_APIKEY`, `EVOLUTION_INSTANCIA` (opcional, para o envio automático)
   - `HORARIO_COBRANCA` = hora de começar a cobrar, ex.: `09:00`
   - `ENVIO_AUTOMATICO` = `sim` ou `nao`
   - `WHATSAPP_TESTE` = seu WhatsApp com DDD, para o botão "Mandar teste"

Abra o app pelo endereço do Railway: ele já sabe onde está o servidor e só pede a senha uma vez. Horário, envio e Evolution vêm sempre dessas variáveis.
4. Settings > Networking > Generate Domain.
5. No app: Ajustes > Nuvem (Railway), cole o endereço e a senha.
