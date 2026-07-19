export async function onRequest(context) {
  const url = new URL(context.request.url);

  if (url.hostname === "www.burnthday.com") {
    url.protocol = "https:";
    url.hostname = "burnthday.com";
    url.port = "";
    return Response.redirect(url.toString(), 301);
  }

  return context.next();
}
