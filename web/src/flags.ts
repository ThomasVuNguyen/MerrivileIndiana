// The chat UI prototype: on with ?chat=new, off with ?chat=old; the choice sticks per browser.
function read() {
  try {
    const asked = new URLSearchParams(location.search).get('chat')
    if (asked) localStorage.setItem('merrivile:chat', asked)
    return (asked ?? localStorage.getItem('merrivile:chat')) === 'new'
  } catch {
    return false
  }
}

export const chatNext = read()
if (chatNext) document.documentElement.classList.add('chat-next')
