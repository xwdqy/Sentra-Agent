import axios from 'axios';

const instance = axios.create({
  maxRedirects: 5,
  // 允许大文件下载（图片、视频等）
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});

export async function httpRequest(config = {}) {
  const { timeoutMs, ...rest } = config || {};
  return instance.request({
    timeout: timeoutMs,
    ...rest,
  });
}

export async function httpGet(url, options = {}) {
  const { timeoutMs, headers, responseType, validateStatus } = options || {};
  return httpRequest({
    method: 'get',
    url,
    headers,
    responseType,
    validateStatus,
    timeoutMs,
  });
}
export const httpClient = instance;

export default { httpRequest, httpGet, httpClient };
