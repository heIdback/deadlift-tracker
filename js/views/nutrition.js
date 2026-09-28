// Placeholder per the spec: navigation + Firestore structure ready,
// full nutrition tracking intentionally deferred beyond v1.
export async function mount(root) {
  root.innerHTML = `
    <section class="empty-state">
      <h2>Nutrition</h2>
      <p>Nutrition tracking isn't available yet — coming in a future version.</p>
    </section>`;
}
