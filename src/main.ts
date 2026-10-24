import '@fontsource-variable/inter';
import './styles/tokens.css';
import './styles/main.css';
import './styles/table.css';
import { App } from './ui/app';

const root = document.getElementById('app');
if (!root) throw new Error('#app root element is missing');

const app = new App(root);
app.boot();
