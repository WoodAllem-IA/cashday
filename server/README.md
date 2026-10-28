# Servidor do CashDay (Railway)

Guarda os dados no Postgres (com backups automáticos), guarda fotos e documentos
e roda o robô de cobrança pela Evolution API.

1. Railway: New Project > Deploy from GitHub repo > `WoodAllem-IA/cashday`.
2. No projeto: Create > Database > PostgreSQL.
3. No serviço `cashday` > Variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `APP_SENHA` = a senha do administrador (entra com o usuário `admin`)
   - `ADMIN_USUARIO` (opcional) = troca o nome do usuário do administrador
   - `EVOLUTION_URL` e `EVOLUTION_APIKEY` (a chave global, `AUTHENTICATION_API_KEY` da Evolution), para o envio automático
   - `EVOLUTION_INSTANCIA` (opcional) = instância já conectada que o administrador quer continuar usando
   - `HORARIO_COBRANCA` (opcional) = hora de começar a cobrar, ex.: `09:00`, igual para todas as contas
   - `ENVIO_AUTOMATICO` (opcional) = `sim` ou `nao`, igual para todas as contas
   - `WHATSAPP_TESTE` (opcional) = WhatsApp do administrador com DDD, para o botão "Mandar teste"

Abra o app pelo endereço do Railway: ele já sabe onde está o servidor e só pede a senha uma vez.
Sem `HORARIO_COBRANCA` e `ENVIO_AUTOMATICO`, cada conta escolhe o horário e liga o envio em Ajustes.
4. Settings > Networking > Generate Domain.
5. No app: Ajustes > Nuvem (Railway), cole o endereço e a senha.

## Usuários

O administrador entra com o usuário `admin` (ou o de `ADMIN_USUARIO`) e a senha de `APP_SENHA`. Em Ajustes > Administração ele vê quantos usuários existem, cadastra novos, troca a senha e bloqueia. Cada usuário vê só os próprios clientes.

## WhatsApp de cada conta

Cada conta (o administrador e cada usuário) tem a própria instância na Evolution e conecta o próprio WhatsApp:
em Ajustes > WhatsApp e envio automático, toque em **Conectar pelo QR Code** e leia o código no celular
(WhatsApp > Aparelhos conectados > Conectar aparelho). A instância é criada sozinha na primeira vez, com o nome
`cashday-<usuário>`. O robô cobra os clientes de cada conta pelo WhatsApp dela, e espera enquanto ele estiver desconectado.

Com o WhatsApp conectado, os botões **Cobrar** e **Cobrar todos** continuam abrindo a mensagem para editar, mas
**Enviar no WhatsApp** manda direto pela Evolution, sem abrir o link do WhatsApp. O cliente cobrado assim não
recebe de novo do robô no mesmo dia.
