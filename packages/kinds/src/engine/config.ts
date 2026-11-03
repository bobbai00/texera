// How the engine client authenticates: the app installs the token getter once.

let getToken: () => string | undefined = () => undefined;

export function configureEngine(options: { getToken: () => string | undefined }) {
  getToken = options.getToken;
}

export const engineToken = () => getToken();
