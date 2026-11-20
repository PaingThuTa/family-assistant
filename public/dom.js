// Tiny element builder. Props go through Object.assign, so text is always set as textContent.
export function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
