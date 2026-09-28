export async function mount(root) {
  root.innerHTML = `
    <section class="empty-state">
      <h2>Page not found</h2>
      <a class="btn btn-secondary" href="#/home">Back to Dashboard</a>
    </section>`;
}
