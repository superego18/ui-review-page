export function createTransport(base) {
  async function request(data) {
    const response = await fetch(base + '/api', data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '저장 서버에 연결하지 못했습니다.');
    return result;
  }
  return { load: () => request(), create: (item) => request({ action: 'create', item }), update: (id, item) => request({ action: 'update', id, item }), remove: (id) => request({ action: 'delete', id }) };
}
