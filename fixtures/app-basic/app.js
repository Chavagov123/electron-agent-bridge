// Fixture behaviour: deterministic, no timers except the toast lifetime.
(() => {
  const form = document.getElementById('order-form');
  const orders = document.getElementById('orders');
  const toast = document.getElementById('toast');
  const confirmBox = document.getElementById('confirm');

  const showToast = (text) => {
    toast.textContent = text;
    setTimeout(() => {
      toast.textContent = '';
    }, 3000);
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const customer = String(data.get('customer') || '').trim();
    if (!customer) {
      showToast('Customer is required');
      return;
    }
    const item = document.createElement('li');
    item.textContent = `${customer} x${data.get('quantity')} (${data.get('priority')}, ${data.get('delivery')})`;
    orders.appendChild(item);
    showToast('Order saved');
  });

  document.getElementById('open-dialog').addEventListener('click', () => {
    confirmBox.hidden = false;
  });
  document.getElementById('confirm-no').addEventListener('click', () => {
    confirmBox.hidden = true;
  });
  document.getElementById('confirm-yes').addEventListener('click', () => {
    confirmBox.hidden = true;
    orders.lastElementChild?.remove();
    showToast('Order deleted');
  });

  // Playground: file pick, HTML5 drag and drop, a failing console + resource load, a far-away button.
  document.getElementById('attachment').addEventListener('change', (event) => {
    showToast(`Attached ${event.target.files[0]?.name ?? 'nothing'}`);
  });
  const card = document.getElementById('card');
  const done = document.getElementById('done');
  card.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', card.id));
  done.addEventListener('dragover', (event) => event.preventDefault());
  done.addEventListener('drop', (event) => {
    event.preventDefault();
    if (event.dataTransfer.getData('text/plain') !== card.id) return;
    done.appendChild(card);
    showToast('Card moved');
  });
  document.getElementById('covered').addEventListener('click', () => showToast('Covered clicked'));
  document.getElementById('break').addEventListener('click', () => {
    console.error('fixture failure');
    const image = document.createElement('img');
    image.alt = '';
    image.src = 'missing-image.png';
    document.body.appendChild(image);
  });
  document.getElementById('far').addEventListener('click', () => showToast('Far clicked'));

  // Keyboard shortcut: Ctrl/Cmd+S submits the form.
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      form.requestSubmit();
    }
  });
})();
