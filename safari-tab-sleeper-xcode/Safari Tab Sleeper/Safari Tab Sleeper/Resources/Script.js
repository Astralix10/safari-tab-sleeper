function show(enabled, useSettingsInsteadOfPreferences) {
    if (useSettingsInsteadOfPreferences) {
        document.getElementsByClassName('state-on')[0].innerText = "Расширение Safari Tab Sleeper включено. Отключить его можно в разделе расширений настроек Safari.";
        document.getElementsByClassName('state-off')[0].innerText = "Расширение Safari Tab Sleeper выключено. Включите его в разделе расширений настроек Safari.";
        document.getElementsByClassName('state-unknown')[0].innerText = "Расширение Safari Tab Sleeper можно включить в разделе расширений настроек Safari.";
        document.getElementsByClassName('open-preferences')[0].innerText = "Открыть настройки Safari…";
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

function showError(message) {
    const detail = String(message || "Неизвестная ошибка.");
    document.getElementsByClassName('state-unknown')[0].innerText = `Не удалось проверить расширение: ${detail}`;
    document.body.classList.remove('state-on');
    document.body.classList.remove('state-off');
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);
