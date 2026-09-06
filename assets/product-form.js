if (!customElements.get('product-form')) {
  const LOADING_SAFETY_TIMEOUT = 8000;

  function showSubmitSpinner(submitButton) {
    submitButton.classList.add('loading');
    submitButton.querySelector('.loading__spinner')?.classList.remove('hidden');
    clearTimeout(submitButton._loadingSafetyTimeout);
    submitButton._loadingSafetyTimeout = setTimeout(() => hideSubmitSpinner(submitButton), LOADING_SAFETY_TIMEOUT);
  }

  function hideSubmitSpinner(submitButton) {
    clearTimeout(submitButton._loadingSafetyTimeout);
    submitButton.classList.remove('loading');
    submitButton.querySelector('.loading__spinner')?.classList.add('hidden');
  }

  // Third-party cart/checkout apps (e.g. GoKwik's cart-slide-drawer embed) attach their
  // own capture-phase click listener straight onto this submit button and call
  // preventDefault, so the form's `submit` event never fires and ProductForm's own
  // loading-state logic in onSubmitHandler never runs. A listener on `document` in the
  // capture phase always runs before a listener on the button itself (capture goes
  // document -> ... -> target before the target's own listeners fire), so this shows
  // the spinner regardless of whether something else hijacks the click afterwards.
  document.addEventListener(
    'click',
    (evt) => {
      const submitButton = evt.target.closest('.product-form__submit');
      if (!submitButton || submitButton.disabled || submitButton.getAttribute('aria-disabled') === 'true') return;
      showSubmitSpinner(submitButton);
    },
    true
  );

  // Hide it again once whatever third-party cart UI opens/refreshes after its own
  // add-to-cart call completes.
  ['cart:refresh', 'cart:open', 'cart-drawer:open', 'sidecart:open', 'ajax-cart:open'].forEach((eventName) => {
    document.addEventListener(eventName, () => {
      document.querySelectorAll('.product-form__submit.loading').forEach(hideSubmitSpinner);
    });
  });

  customElements.define(
    'product-form',
    class ProductForm extends HTMLElement {
      constructor() {
        super();

        this.form = this.querySelector('form');
        this.variantIdInput.disabled = false;
        this.form.addEventListener('submit', this.onSubmitHandler.bind(this));
        this.cart = document.querySelector('cart-notification') || document.querySelector('cart-drawer');

        if (document.querySelector('cart-drawer')) this.submitButton.setAttribute('aria-haspopup', 'dialog');

        this.hideErrors = this.dataset.hideErrors === 'true';
      }

      onSubmitHandler(evt) {
        evt.preventDefault();
        if (this.submitButton.getAttribute('aria-disabled') === 'true') return;

        this.handleErrorMessage();

        this.submitButton.setAttribute('aria-disabled', true);
        showSubmitSpinner(this.submitButton);

        const config = fetchConfig('javascript');
        config.headers['X-Requested-With'] = 'XMLHttpRequest';
        delete config.headers['Content-Type'];

        const formData = new FormData(this.form);
        if (this.cart) {
          formData.append(
            'sections',
            this.cart.getSectionsToRender().map((section) => section.id)
          );
          formData.append('sections_url', window.location.pathname);
          this.cart.setActiveElement(document.activeElement);
        }
        config.body = formData;

        fetch(`${routes.cart_add_url}`, config)
          .then((response) => response.json())
          .then((response) => {
            if (response.status) {
              publish(PUB_SUB_EVENTS.cartError, {
                source: 'product-form',
                productVariantId: formData.get('id'),
                errors: response.errors || response.description,
                message: response.message,
              });
              this.handleErrorMessage(response.description);

              const soldOutMessage = this.submitButton.querySelector('.sold-out-message');
              if (!soldOutMessage) return;
              this.submitButton.setAttribute('aria-disabled', true);
              this.submitButtonText.classList.add('hidden');
              soldOutMessage.classList.remove('hidden');
              this.error = true;
              return;
            } else if (!this.cart) {
              window.location = window.routes.cart_url;
              return;
            }

            if (!this.error)
              publish(PUB_SUB_EVENTS.cartUpdate, {
                source: 'product-form',
                productVariantId: formData.get('id'),
                cartData: response,
              });
            this.error = false;
            const quickAddModal = this.closest('quick-add-modal');
            if (quickAddModal) {
              document.body.addEventListener(
                'modalClosed',
                () => {
                  setTimeout(() => {
                    this.cart.renderContents(response);
                  });
                },
                { once: true }
              );
              quickAddModal.hide(true);
            } else {
              this.cart.renderContents(response);
            }
          })
          .catch((e) => {
            console.error(e);
          })
          .finally(() => {
            hideSubmitSpinner(this.submitButton);
            if (this.cart && this.cart.classList.contains('is-empty')) this.cart.classList.remove('is-empty');
            if (!this.error) this.submitButton.removeAttribute('aria-disabled');
          });
      }

      handleErrorMessage(errorMessage = false) {
        if (this.hideErrors) return;

        this.errorMessageWrapper =
          this.errorMessageWrapper || this.querySelector('.product-form__error-message-wrapper');
        if (!this.errorMessageWrapper) return;
        this.errorMessage = this.errorMessage || this.errorMessageWrapper.querySelector('.product-form__error-message');

        this.errorMessageWrapper.toggleAttribute('hidden', !errorMessage);

        if (errorMessage) {
          this.errorMessage.textContent = errorMessage;
        }
      }

      toggleSubmitButton(disable = true, text) {
        if (disable) {
          this.submitButton.setAttribute('disabled', 'disabled');
          if (text) this.submitButtonText.textContent = text;
        } else {
          this.submitButton.removeAttribute('disabled');
          this.submitButtonText.textContent = window.variantStrings.addToCart;
        }
      }

      get variantIdInput() {
        return this.form.querySelector('[name=id]');
      }

      get submitButton() {
        return this.querySelector('[type="submit"]');
      }

      get submitButtonText() {
        return this.submitButton.querySelector('span');
      }
    }
  );
}
