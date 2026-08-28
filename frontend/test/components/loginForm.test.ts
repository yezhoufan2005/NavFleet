import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import LoginForm from "../../src/components/LoginForm.vue";

/**
 * The login screen is the one page every user must get through, and it was the
 * least accessible: unnamed form, unannounced errors, no autofocus. These assert
 * the properties assistive tech actually relies on, not the markup around them.
 */
describe("LoginForm accessibility", () => {
  it("names the form and links both fields to their labels", () => {
    const wrapper = mount(LoginForm, { attachTo: document.body });

    const form = wrapper.get("form");
    expect(form.attributes("aria-labelledby")).toBe("login-heading");
    expect(wrapper.get("#login-heading").text()).toBeTruthy();

    for (const [id, labelText] of [
      ["#login-username", "用户名"],
      ["#login-password", "密码"],
    ]) {
      const input = wrapper.get(id);
      const label = wrapper.get(`label[for="${id.slice(1)}"]`);
      expect(label.text()).toContain(labelText);
      expect(input.attributes("required")).toBeDefined();
    }

    wrapper.unmount();
  });

  it("focuses the first field on mount so a keyboard user can just type", () => {
    const wrapper = mount(LoginForm, { attachTo: document.body });

    expect(document.activeElement).toBe(wrapper.get("#login-username").element);

    wrapper.unmount();
  });

  it("announces a rejected login and marks both fields invalid", async () => {
    const wrapper = mount(LoginForm, { attachTo: document.body });

    expect(wrapper.find("#login-error").exists()).toBe(false);
    expect(wrapper.get("#login-username").attributes("aria-invalid")).toBeUndefined();

    await wrapper.setProps({ error: "用户名或密码错误" });

    // role="alert" is what makes a screen reader read the message out; without it
    // the only feedback is a colour change.
    const alert = wrapper.get("#login-error");
    expect(alert.attributes("role")).toBe("alert");
    expect(alert.text()).toContain("用户名或密码错误");
    for (const id of ["#login-username", "#login-password"]) {
      expect(wrapper.get(id).attributes("aria-invalid")).toBe("true");
      expect(wrapper.get(id).attributes("aria-describedby")).toBe("login-error");
    }

    wrapper.unmount();
  });

  it("marks the form busy while the submit is in flight", async () => {
    const wrapper = mount(LoginForm, { attachTo: document.body });
    expect(wrapper.get("form").attributes("aria-busy")).toBe("false");

    await wrapper.setProps({ pending: true });

    expect(wrapper.get("form").attributes("aria-busy")).toBe("true");
    expect(wrapper.get("button[type=submit]").attributes("disabled")).toBeDefined();

    wrapper.unmount();
  });

  it("still refuses to submit an incomplete form", async () => {
    const wrapper = mount(LoginForm, { attachTo: document.body });

    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")).toBeUndefined();

    await wrapper.get("#login-username").setValue("admin");
    await wrapper.get("#login-password").setValue("secret");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("submit")).toEqual([[{ username: "admin", password: "secret" }]]);

    wrapper.unmount();
  });
});
