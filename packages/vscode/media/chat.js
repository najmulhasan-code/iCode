// Script of the chat panel. It runs inside the webview, which has no access to
// files or to the VS Code API. It talks to the extension through messages only.
//
// Everything a model writes is put on the page with textContent, so it is
// always shown as plain text and never interpreted as markup.
(function () {
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const welcome = document.getElementById('welcome');
  const status = document.getElementById('status');
  const input = document.getElementById('input');
  const sendButton = document.getElementById('send');
  const stopButton = document.getElementById('stop');

  const NOTE_BY_STOP_REASON = {
    cancelled: 'Stopped.',
    max_tokens: 'The reply reached the length limit.',
    refusal: 'The model declined this request.',
  };

  let busy = false;
  /** The element the reply that is being written goes into. */
  let reply = null;

  function add(kind, text) {
    const element = document.createElement('div');
    element.className = `message ${kind}`;
    element.textContent = text;
    messages.append(element);
    messages.scrollTop = messages.scrollHeight;
    return element;
  }

  function setBusy(value) {
    busy = value;
    status.hidden = !value;
    stopButton.hidden = !value;
    sendButton.hidden = value;
    updateSendButton();
  }

  function updateSendButton() {
    sendButton.disabled = busy || input.value.trim() === '';
  }

  function submit(text) {
    const trimmed = text.trim();
    if (busy || trimmed === '') {
      return;
    }
    welcome.hidden = true;
    add('user', trimmed);
    reply = add('assistant', '');
    setBusy(true);
    vscode.postMessage({ type: 'send', text: trimmed });
  }

  function finish(note, kind) {
    if (reply !== null && reply.textContent === '') {
      reply.remove();
    }
    reply = null;
    if (note !== undefined) {
      add(kind, note);
    }
    setBusy(false);
    input.focus();
  }

  sendButton.addEventListener('click', () => {
    submit(input.value);
    input.value = '';
    updateSendButton();
  });
  stopButton.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
  });
  input.addEventListener('input', updateSendButton);
  input.addEventListener('keydown', (event) => {
    // Enter sends. Shift and Enter starts a new line.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendButton.click();
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'text' && reply !== null) {
      reply.textContent += message.text;
      messages.scrollTop = messages.scrollHeight;
    } else if (message.type === 'end') {
      finish(NOTE_BY_STOP_REASON[message.stopReason], 'note');
    } else if (message.type === 'error') {
      finish(message.message, 'error');
    } else if (message.type === 'submit') {
      submit(message.text);
    }
  });

  updateSendButton();
  vscode.postMessage({ type: 'ready' });
})();
