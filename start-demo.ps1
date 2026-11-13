#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Endpoint,
    [string]$Deployment,
    [string]$SubscriptionId
)

$ErrorActionPreference = 'Stop'
$registry = 'https://packagefeedproxy.microsoft.io/npm'

function Set-DemoSetting {
    param([string]$Name, [string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -match '[\r\n"]') {
        throw "Valor invalido para $Name."
    }
    $path = Join-Path $PSScriptRoot '.env'
    $content = [System.IO.File]::ReadAllText($path)
    $pattern = '(?m)^(?:export\s+)?' + [regex]::Escape($Name) + '\s*=.*$'
    $line = $Name + '="' + $Value + '"'
    if ([regex]::IsMatch($content, $pattern)) {
        $content = [regex]::Replace($content, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $line })
    } else {
        $content = $content.TrimEnd() + [Environment]::NewLine + $line + [Environment]::NewLine
    }
    [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

Push-Location $PSScriptRoot
try {
    foreach ($tool in @('node', 'npm.cmd', 'az.cmd')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            throw "Instale Node.js 24+ (com npm) e Azure CLI antes de executar. Ferramenta ausente: $tool."
        }
    }
    $major = & node -p 'process.versions.node.split(".")[0]'
    if ($LASTEXITCODE -ne 0 -or [int]$major -lt 24) {
        throw 'Esta demo exige Node.js 24 ou superior.'
    }

    if (-not (Test-Path -LiteralPath '.env')) {
        Copy-Item -LiteralPath '.env.example' -Destination '.env'
    }
    $settingsJson = & node --env-file=.env -e 'const e = process.env; console.log(JSON.stringify({ endpoint: e.AZURE_ENDPOINT, deployment: e.DEPLOYMENT_NAME, subscription: e.AZURE_SUBSCRIPTION_ID }));'
    if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel ler a configuracao do .env.' }
    $settings = $settingsJson | ConvertFrom-Json

    if (-not $Endpoint) { $Endpoint = $settings.endpoint }
    if (-not $Endpoint -or $Endpoint -match 'YOUR-|example-foundry') {
        $Endpoint = Read-Host 'Endpoint HTTPS raiz do recurso Foundry existente (sem /api/projects)'
    }
    if (-not $Deployment) { $Deployment = $settings.deployment }
    if (-not $Deployment) {
        $Deployment = Read-Host 'Nome do deployment Microsoft-Decision-1 existente'
    }
    if (-not $SubscriptionId) { $SubscriptionId = $settings.subscription }
    if (-not $SubscriptionId -or $SubscriptionId -match 'YOUR-' -or $SubscriptionId -eq '00000000-0000-0000-0000-000000000000') {
        $SubscriptionId = Read-Host 'ID da assinatura Azure que possui o deployment'
    }

    $endpointUri = $null
    if (-not [Uri]::TryCreate($Endpoint, [UriKind]::Absolute, [ref]$endpointUri) -or
        $endpointUri.Scheme -ne 'https' -or
        $Endpoint -notmatch '^https://[a-zA-Z0-9-]+\.(cognitiveservices\.azure\.com|services\.ai\.azure\.com)/?$') {
        throw 'Informe o endpoint raiz HTTPS do recurso Azure Foundry, sem caminho de projeto.'
    }
    $subscriptionGuid = [Guid]::Empty
    if (-not [Guid]::TryParse($SubscriptionId, [ref]$subscriptionGuid)) {
        throw 'O ID da assinatura Azure deve ser um GUID.'
    }
    Set-DemoSetting 'AZURE_ENDPOINT' $Endpoint
    Set-DemoSetting 'DEPLOYMENT_NAME' $Deployment
    Set-DemoSetting 'AZURE_SUBSCRIPTION_ID' $SubscriptionId

    Write-Host 'Verificando dependencias npm...'
    & npm.cmd ls --omit=dev --silent *> $null
    if ($LASTEXITCODE -ne 0) {
        & npm.cmd ci --registry=$registry --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar dependencias pelo proxy npm.' }
    }

    $configJson = & node --env-file=.env --input-type=module -e 'import { readConfig } from "./server.js"; const c = readConfig(process.env); if (c.hosted) throw new Error("Execute este script fora do Azure App Service."); console.log(JSON.stringify({ port: c.port, login: Boolean(c.auth) }));'
    if ($LASTEXITCODE -ne 0) { throw 'Configuracao invalida. Corrija o .env conforme o erro acima.' }
    $config = $configJson | ConvertFrom-Json

    Write-Host 'Verificando sessao Azure para a assinatura configurada...'
    & az.cmd account show --subscription $SubscriptionId --output none --only-show-errors
    if ($LASTEXITCODE -ne 0) {
        & az.cmd login --output none --only-show-errors
        if ($LASTEXITCODE -ne 0) { throw 'Falha no az login. Verifique a conta e o tenant.' }
    }
    & az.cmd account get-access-token --subscription $SubscriptionId --resource 'https://cognitiveservices.azure.com/' --output none --only-show-errors
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Renovando a autenticacao Azure...'
        & az.cmd login --scope 'https://cognitiveservices.azure.com/.default' --output none --only-show-errors
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao renovar o login Azure.' }
        & az.cmd account get-access-token --subscription $SubscriptionId --resource 'https://cognitiveservices.azure.com/' --output none --only-show-errors
        if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel obter token para a assinatura configurada.' }
    }

    Write-Host ''
    Write-Host "Iniciando a demo em http://localhost:$($config.port). Aguarde a confirmacao do servidor."
    Write-Host 'Roteiro: DEMO.md. Para encerrar, pressione Ctrl+C.'
    Write-Host 'Use dados ficticios. Inferencias sao cobradas. Nenhum recurso Azure sera criado.'
    Write-Host 'Um token valido nao garante permissao de inferencia nem disponibilidade de quota.'
    if ($config.login) {
        Write-Host 'Login existente preservado. Se gerado pelo projeto, consulte .azure\app-login.txt.'
    } else {
        Write-Host 'Demo local sem login, acessivel somente por loopback.'
    }
    & npm.cmd start
    if ($LASTEXITCODE -ne 0) { throw "O servidor encerrou com erro ($LASTEXITCODE)." }
} finally {
    Pop-Location
}
