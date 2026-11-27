import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createBridge } from './bridge';
import { ChatStore } from './store';
import './styles.css';

const bridge = createBridge();
const store = new ChatStore(bridge.post);

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  store.receive(event.data);
});

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App store={store} />
    </StrictMode>,
  );
}

// The page says when its script is running. Until then it cannot receive anything.
bridge.post({ type: 'ready' });
