<#-- Appchi's approved password form. Other authentication pages inherit Keycloak. -->
<#import "passkeys.ftl" as passkeys>
<#assign invalidCredentials = messagesPerField.existsError('username', 'password')>
<!DOCTYPE html>
<html lang="${lang}" data-theme="light">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign in · Appchi</title>
    <link rel="icon" type="image/svg+xml" href="${url.resourcesPath}/img/appchi.svg">
    <script src="${url.resourcesPath}/js/appearance.js"></script>
    <link rel="stylesheet" href="${url.resourcesPath}/css/appchi.css">
    <script type="importmap">
        {"imports": {"rfc4648": "${url.resourcesCommonPath}/vendor/rfc4648/rfc4648.js"}}
    </script>
    <#if scripts??>
        <#list scripts as script><script src="${script}" type="text/javascript"></script></#list>
    </#if>
    <script type="module" src="${url.resourcesPath}/js/appchi.js"></script>
</head>
<body id="appchi-login" data-sso-check="${url.ssoLoginInOtherTabsUrl}"
      <#if authenticationSession??>data-auth-session="${authenticationSession.authSessionIdHash}"</#if>>
    <main class="ap-stage">
        <section class="ap-panel" aria-labelledby="sign-in-title">
            <div class="ap-brand">
                <div class="ap-mark" aria-hidden="true">A</div>
                <div><div class="ap-name">Appchi</div><div class="ap-tagline">Alert operations, in one place.</div></div>
            </div>
            <h1 class="ap-heading" id="sign-in-title">Sign in</h1>
            <p class="ap-intro">Use your company username and password.</p>
            <#if realm.password>
                <form class="ap-form" id="kc-form-login" action="${url.loginAction}" method="post">
                    <#if invalidCredentials>
                        <div id="input-error" class="ap-message" role="alert">
                            ${kcSanitize(messagesPerField.getFirstError('username', 'password'))?no_esc}
                        </div>
                    <#elseif message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
                        <div class="ap-message ap-message-${message.type}" role="alert">
                            ${kcSanitize(message.summary)?no_esc}
                        </div>
                    </#if>
                    <#if !usernameHidden??>
                        <div>
                            <label class="ap-label" for="username">${msg("username")}</label>
                            <input class="ap-input" id="username" name="username" type="text"
                                   value="${(login.username!'')}" placeholder="Enter your username"
                                   autocomplete="username" autocapitalize="none" spellcheck="false" autofocus required
                                   aria-invalid="${invalidCredentials?c}" <#if invalidCredentials>aria-describedby="input-error"</#if>>
                        </div>
                    </#if>
                    <div>
                        <label class="ap-label" for="password">${msg("password")}</label>
                        <div class="ap-input-wrap">
                            <input class="ap-input ap-password" id="password" name="password" type="password"
                                   placeholder="Enter your password" autocomplete="current-password" required
                                   <#if usernameHidden??>autofocus</#if>
                                   aria-invalid="${invalidCredentials?c}" <#if invalidCredentials>aria-describedby="input-error"</#if>>
                            <button class="ap-eye" type="button" aria-label="${msg('showPassword')}" aria-controls="password"
                                    aria-pressed="false" data-show="${msg('showPassword')}" data-hide="${msg('hidePassword')}" hidden>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>
                                    <path class="ap-eye-slash" d="m3 3 18 18" hidden/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <#if realm.rememberMe && !usernameHidden??>
                        <label><input type="checkbox" name="rememberMe" <#if login.rememberMe??>checked</#if>> ${msg("rememberMe")}</label>
                    </#if>
                    <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>>
                    <button class="ap-submit" name="login" id="kc-login" type="submit">
                        <span class="ap-submit-label">Sign in</span>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>
                    </button>
                    <#if realm.resetPasswordAllowed><a href="${url.loginResetCredentialsUrl}">${msg("doForgotPassword")}</a></#if>
                </form>
            </#if>
            <@passkeys.conditionalUIData />
            <details class="ap-help">
                <summary class="ap-help-link">Need help signing in?</summary>
                <p class="ap-help-note">For account access or password help, contact your company’s IT support.</p>
            </details>
        </section>
        <button class="ap-appearance" type="button" hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20.8 13.5A9 9 0 0 1 10.5 3.2 9 9 0 1 0 20.8 13.5Z"/></svg>
            <span>Dark mode</span>
        </button>
    </main>
</body>
</html>
