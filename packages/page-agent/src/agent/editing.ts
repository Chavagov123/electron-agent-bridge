import { AgentFailure } from './failure.js';

/** What a control holds now, read back after an action to verify it took effect. */
export interface ControlState {
  readonly value?: string;
  readonly checked?: boolean;
  readonly selected?: readonly string[];
}

/**
 * Focus an element for keyboard input; with `selectAll`, select its current content so typed text
 * replaces it. Fails when focus does not land on the element (not focusable).
 */
export function focusForInput(el: Element, selectAll: boolean): void {
  const html = el as HTMLElement;
  html.focus({ preventScroll: true });
  const active = el.ownerDocument.activeElement;
  if (active !== el && !(active && el.contains(active)) && !html.isContentEditable) {
    throw new AgentFailure('INVALID_PARAMS', 'the element cannot receive keyboard focus');
  }
  if (!selectAll) return;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    (el as HTMLInputElement).select();
    return;
  }
  const selection = el.ownerDocument.getSelection();
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function readState(el: Element): ControlState {
  if (el.tagName === 'SELECT') {
    const select = el as HTMLSelectElement;
    return {
      value: select.value,
      selected: Array.from(select.options)
        .filter((option) => option.selected)
        .map((option) => option.value),
    };
  }
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const input = el as HTMLInputElement;
    const checkable = input.type === 'checkbox' || input.type === 'radio';
    return checkable ? { value: input.value, checked: input.checked } : { value: input.value };
  }
  const aria = el.getAttribute('aria-checked');
  if (aria !== null) return { checked: aria === 'true' };
  return { value: el.textContent };
}

/**
 * Set a value the way a framework notices: through the native setter of the element's prototype
 * (bypassing instance overrides such as React's value tracker), then `input` and `change` events.
 * Used only when trusted typing could not produce the value (masks, custom editors).
 */
export function setValueDirectly(el: Element, value: string): void {
  if ((el as HTMLElement).isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
    el.textContent = value;
  } else {
    const prototype = Object.getPrototypeOf(el) as object;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- applied to the element just below
    const setter: unknown = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (typeof setter !== 'function') {
      throw new AgentFailure('INVALID_PARAMS', 'the element has no value to set');
    }
    Reflect.apply(setter, el, [value]);
  }
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Select options of a <select> by value or visible label; every requested value must exist. */
export function selectOptions(el: Element, values: readonly string[]): string[] {
  if (el.tagName !== 'SELECT') throw new AgentFailure('INVALID_PARAMS', 'select needs a <select> element');
  const select = el as HTMLSelectElement;
  if (!select.multiple && values.length > 1) {
    throw new AgentFailure('INVALID_PARAMS', 'this <select> allows a single value');
  }
  const options = Array.from(select.options);
  const chosen = values.map((wanted) => {
    const option = options.find((candidate) => candidate.value === wanted || labelOf(candidate) === wanted);
    if (!option) {
      const available = options.map(labelOf).join(', ');
      throw new AgentFailure('NOT_FOUND', `no option ${JSON.stringify(wanted)} (options: ${available})`);
    }
    if (option.disabled) throw new AgentFailure('DISABLED', `option ${JSON.stringify(wanted)} is disabled`);
    return option;
  });
  for (const option of options) option.selected = chosen.includes(option);
  select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return chosen.map((option) => option.value);
}

/** The text a user sees for an option (`label` falls back to the option text). */
function labelOf(option: HTMLOptionElement): string {
  return (option.label || option.text).trim();
}

/**
 * HTML5 drag and drop through synthetic DragEvents with a shared DataTransfer (Chromium does not start
 * a native drag from CDP mouse events). Reported to the caller as untrusted input.
 */
export function dragAndDrop(source: Element, target: Element): void {
  const transfer = new DataTransfer();
  const fire = (el: Element, type: string): void => {
    el.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer }),
    );
  };
  // The drag starts at the draggable element the source is part of (a handle or label inside a card).
  const dragged = source.closest('[draggable="true"]') ?? source;
  fire(dragged, 'dragstart');
  fire(target, 'dragenter');
  fire(target, 'dragover');
  fire(target, 'drop');
  fire(dragged, 'dragend');
}
