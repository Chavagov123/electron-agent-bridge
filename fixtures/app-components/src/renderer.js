// A React counter and a Vue todo list: component state an agent should be able to read and watch change.
import { createElement, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createApp, defineComponent, h, ref } from 'vue';

function Counter({ label }) {
  const [count, setCount] = useState(0);
  const clicks = useRef(0);
  const [log, add] = useReducer((items, item) => [...items, item], []);
  return createElement(
    'button',
    {
      id: 'react-add',
      onClick: () => {
        clicks.current += 1;
        setCount(count + 1);
        add(`added ${count + 1}`);
      },
    },
    `${label}: ${count} (${log.length})`,
  );
}

function ReactApp() {
  return createElement('section', { 'aria-label': 'React' }, createElement(Counter, { label: 'Count' }));
}

createRoot(document.getElementById('react-root')).render(createElement(ReactApp));

const TodoItem = defineComponent({
  name: 'TodoItem',
  props: { title: { type: String, required: true } },
  // State returned from setup is what Vue (and its devtools) can see; closures are not.
  setup() {
    const done = ref(false);
    return { done };
  },
  render() {
    return h('li', [
      h('label', [
        h('input', { type: 'checkbox', checked: this.done, onChange: () => (this.done = !this.done) }),
        ` ${this.title}`,
      ]),
    ]);
  },
});

const TodoList = defineComponent({
  name: 'TodoList',
  data: () => ({ items: ['Milk', 'Bread'] }),
  render() {
    return h(
      'ul',
      { 'aria-label': 'Todos' },
      this.items.map((title) => h(TodoItem, { title, key: title })),
    );
  },
});

createApp(TodoList).mount('#vue-root');
