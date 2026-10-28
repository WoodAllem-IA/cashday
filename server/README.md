# Servidor do CashDay (Railway)

Guarda os dados no Postgres (com backups automáticos), guarda fotos e documentos
e roda o robô de cobrança pela Evolution API.

1. Railway: New Project > Deploy from GitHub repo > `WoodAllem-IA/cashday`.
2. No projeto: Create > Database > PostgreSQL.
3. No serviço `cashday` > Variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `APP_SENHA` = a senha do administrador (entra com o usuário `admin`)
   - `ADMIN_USUARIO` (opcional) = troca o nome do usuário do administrador
   - `EVOLUTION_URL`, `EVOLUTION_APIKEY`, `EVOLUTION_INSTANCIA` (opcional, para o envio automático)
   - `HORARIO_COBRANCA` = hora de começar a cobrar, ex.: `09:00`
   - `ENVIO_AUTOMATICO` = `sim` ou `nao`
   - `WHATSAPP_TESTE` = seu WhatsApp com DDD, para o botão "Mandar teste"

Abra o app pelo endereço do Railway: ele já sabe onde está o servidor e só pede a senha uma vez. Horário, envio e Evolution vêm sempre dessas variáveis.
4. Settings > Networking > Generate Domain.
5. No app: Ajustes > Nuvem (Railway), cole o endereço e a senha.

## Usuários

O administrador entra com o usuário `admin` (ou o de `ADMIN_USUARIO`) e a senha de `APP_SENHA`. Em Ajustes > Administração ele vê quantos usuários existem, cadastra novos, troca a senha e bloqueia. Cada usuário vê só os próprios clientes. O envio automático pela Evolution usa o WhatsApp do administrador, então vale só para os clientes dele; os outros usuários cobram pelo botão "Cobrar".
