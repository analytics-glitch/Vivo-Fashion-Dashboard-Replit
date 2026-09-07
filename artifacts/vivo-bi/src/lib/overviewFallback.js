export async function loadOverviewFallback(client, requests, timeout = 15_000) {
  const settled = await Promise.allSettled(
    requests.map(({ path, params }) => client.get(path, { params, timeout })),
  );
  return settled.reduce((result, item, index) => {
    const request = requests[index];
    if (item.status === "fulfilled") {
      result.data[request.key] = item.value?.data;
    } else {
      result.failed.push(request.key);
    }
    return result;
  }, { data: {}, failed: [] });
}