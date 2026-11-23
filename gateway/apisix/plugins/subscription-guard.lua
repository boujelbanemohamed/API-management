--
-- subscription-guard : contrôle d'abonnement à chaque appel (plateforme API Management).
--
-- S'exécute après l'authentification (key-auth, puis plus tard openid-connect / mTLS) et vérifie,
-- pour le couple (institution, service) :
--   1. qu'un abonnement existe et est actif          -> sinon 403
--   2. que la date du jour est dans la période        -> sinon 403
--   3. que l'adresse IP appelante est autorisée       -> sinon 403
--   4. le débit (requêtes / seconde)                  -> sinon 429
--   5. le quota journalier                            -> sinon 429 (politique BLOCK)
--
-- Les droits sont écrits dans Valkey par le back-end (GatewaySyncService) sous la clé
--   <prefix>:sub:<consumer>:<route_id>
-- Compteurs :
--   <prefix>:usage:<consumer>:<route_id>:<AAAAMMJJ>   (expire après 48 h)
--   <prefix>:rate:<consumer>:<route_id>:<epoch_s>      (expire après 2 s)
--
-- En cas d'indisponibilité de Valkey, l'appel est refusé (503) : on ne laisse jamais passer
-- un appel dont on ne peut pas vérifier les droits.
--
-- Configuration (conf/config.yaml) :
--   plugin_attr:
--     subscription-guard:
--       host: valkey
--       port: 6379
--       password: ""        # facultatif
--       database: 0
--       prefix: apigw
--       timeout_ms: 200
--       utc_offset_hours: 1 # heure de Tunis (pas d'heure d'été)
--
local core      = require("apisix.core")
local plugin    = require("apisix.plugin")
local redis     = require("resty.redis")
local ipmatcher = require("resty.ipmatcher")

local ngx      = ngx
local tonumber = tonumber
local tostring = tostring
local os_date  = os.date

local plugin_name = "subscription-guard"

local schema = {
    type = "object",
    properties = {
        -- Ajoute les en-têtes X-Quota-Limit / X-Quota-Remaining à la réponse.
        expose_quota_headers = { type = "boolean", default = true },
    },
}

local attr_schema = {
    type = "object",
    properties = {
        host             = { type = "string", default = "127.0.0.1" },
        port             = { type = "integer", default = 6379 },
        password         = { type = "string", default = "" },
        database         = { type = "integer", default = 0 },
        prefix           = { type = "string", default = "apigw" },
        timeout_ms       = { type = "integer", default = 200 },
        keepalive_ms     = { type = "integer", default = 60000 },
        pool_size        = { type = "integer", default = 100 },
        utc_offset_hours = { type = "integer", default = 1 },
    },
}

local _M = {
    version = 0.1,
    -- Après key-auth (2500), avant les plugins de transformation (proxy-rewrite : 1008).
    priority = 2400,
    name = plugin_name,
    schema = schema,
}

local REASON_MESSAGES = {
    pending          = "Abonnement en attente de validation.",
    suspended        = "Abonnement suspendu.",
    expired          = "Abonnement expiré.",
    not_started      = "Abonnement pas encore commencé.",
    partner_inactive = "Institution suspendue ou en cours de validation.",
    no_ip_allowlist  = "Aucune adresse IP autorisée n'est déclarée pour votre institution.",
}

local matcher_cache = core.lrucache.new({ ttl = 300, count = 2048 })

function _M.check_schema(conf)
    return core.schema.check(schema, conf)
end

local function get_attr()
    local attr = plugin.plugin_attr(plugin_name) or {}
    local ok, err = core.schema.check(attr_schema, attr) -- remplit les valeurs par défaut
    if not ok then
        core.log.error("plugin_attr subscription-guard invalide : ", err)
    end
    return attr
end

local function reject(status, code, message)
    return status, { error = code, message = message, request_id = core.request.header(nil, "X-Request-Id") }
end

local function connect(attr)
    local red = redis:new()
    red:set_timeouts(attr.timeout_ms, attr.timeout_ms, attr.timeout_ms)
    local ok, err = red:connect(attr.host, attr.port)
    if not ok then
        return nil, err
    end
    if attr.password ~= "" and red:get_reused_times() == 0 then
        local auth_ok, auth_err = red:auth(attr.password)
        if not auth_ok then
            return nil, auth_err
        end
    end
    if attr.database ~= 0 then
        local sel_ok, sel_err = red:select(attr.database)
        if not sel_ok then
            return nil, sel_err
        end
    end
    return red
end

local function release(red, attr)
    local ok, err = red:set_keepalive(attr.keepalive_ms, attr.pool_size)
    if not ok then
        core.log.warn("set_keepalive : ", err)
    end
end

local function ip_allowed(allowed_ips, client_ip)
    if not allowed_ips or #allowed_ips == 0 then
        return true -- en production, le back-end n'active jamais un droit sans liste d'IP
    end
    local key = core.json.encode(allowed_ips)
    local matcher = matcher_cache(key, nil, ipmatcher.new, allowed_ips)
    if not matcher then
        return false
    end
    return matcher:match(client_ip)
end

function _M.access(conf, ctx)
    local consumer = ctx.consumer_name
    local route_id = ctx.route_id
    if not consumer or not route_id then
        -- Sans consumer identifié, l'authentification aurait dû échouer avant nous.
        return reject(401, "unauthenticated", "Authentification requise.")
    end

    local attr = get_attr()
    local red, err = connect(attr)
    if not red then
        core.log.error("Valkey indisponible : ", err)
        return reject(503, "rights_unavailable", "Contrôle des droits momentanément indisponible.")
    end

    local base = consumer .. ":" .. route_id
    local raw, get_err = red:get(attr.prefix .. ":sub:" .. base)
    if get_err then
        core.log.error("lecture des droits : ", get_err)
        return reject(503, "rights_unavailable", "Contrôle des droits momentanément indisponible.")
    end
    if raw == ngx.null or raw == nil then
        release(red, attr)
        return reject(403, "no_subscription", "Votre institution n'est pas abonnée à ce service.")
    end

    local right = core.json.decode(raw)
    if not right then
        release(red, attr)
        core.log.error("droit illisible pour ", base)
        return reject(503, "rights_unavailable", "Contrôle des droits momentanément indisponible.")
    end

    if right.status ~= "active" then
        release(red, attr)
        return reject(403, "subscription_" .. tostring(right.reason or "inactive"),
            REASON_MESSAGES[right.reason] or "Abonnement inactif.")
    end

    -- Dates contrôlées ici aussi : l'accès se ferme à minuit (heure de Tunis) sans attendre le back-end.
    local now = ngx.time()
    local local_now = now + attr.utc_offset_hours * 3600
    local today = os_date("!%Y-%m-%d", local_now)
    if today < right.start then
        release(red, attr)
        return reject(403, "subscription_not_started", REASON_MESSAGES.not_started)
    end
    if today > right["end"] then
        release(red, attr)
        return reject(403, "subscription_expired", REASON_MESSAGES.expired)
    end

    if not ip_allowed(right.allowed_ips, core.request.get_remote_client_ip(ctx)) then
        release(red, attr)
        return reject(403, "ip_not_allowed", "Adresse IP non autorisée pour votre institution.")
    end

    -- Débit et quota en un seul aller-retour.
    local rate_key = attr.prefix .. ":rate:" .. base .. ":" .. now
    local usage_key = attr.prefix .. ":usage:" .. base .. ":" .. os_date("!%Y%m%d", local_now)
    red:init_pipeline()
    red:incr(rate_key)
    red:expire(rate_key, 2)
    red:incr(usage_key)
    red:expire(usage_key, 172800)
    local results, pipe_err = red:commit_pipeline()
    if not results then
        core.log.error("compteurs : ", pipe_err)
        return reject(503, "rights_unavailable", "Contrôle des droits momentanément indisponible.")
    end
    release(red, attr)

    local rate = tonumber(results[1]) or 0
    local used = tonumber(results[3]) or 0
    local quota = tonumber(right.daily_quota) or 0

    if conf.expose_quota_headers then
        ctx.subscription_guard_headers = {
            ["X-Quota-Limit"] = quota,
            ["X-Quota-Remaining"] = quota > used and (quota - used) or 0,
        }
    end

    if rate > (tonumber(right.rate_per_second) or 0) then
        return reject(429, "rate_limited", "Débit maximum dépassé. Réessayez dans une seconde.")
    end

    if used > quota then
        if right.overage == "BLOCK" then
            return reject(429, "quota_exceeded", "Quota journalier atteint. Il sera réinitialisé à minuit.")
        end
        -- ALLOW_AND_BILL / ALERT_ONLY : l'appel passe, le dépassement est signalé.
        core.request.set_header(ctx, "X-Quota-Exceeded", "true")
    end
end

function _M.header_filter(conf, ctx)
    local headers = ctx.subscription_guard_headers
    if headers then
        for name, value in pairs(headers) do
            core.response.set_header(name, value)
        end
    end
end

return _M
