import { parse, wrappers, type CloudflareMailEnv } from "@mvrx/mail";

export default {
  async email(message: ForwardableEmailMessage, env: CloudflareMailEnv) {
    const email = await parse(message, {
      wrapper: wrappers.xml("email"),
    });

    console.log({
      messageId: email.messageId,
      threadId: email.threadId,
      from: email.metadata.from.email,
      subject: email.metadata.subject,
      forAI: email.content.forAI,
    });
  },

  async fetch(): Promise<Response> {
    return new Response("AECS basic Worker example");
  },
};
