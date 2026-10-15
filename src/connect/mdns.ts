import Bonjour from 'bonjour-service';
export function connectorHostname(id: string) {
  return (
    'wishos-' +
    id
      .replace(/[^a-z0-9]/gi, '')
      .slice(-16)
      .toLowerCase() +
    '.local'
  );
}
export class ConnectorDiscovery {
  private service?: InstanceType<typeof Bonjour>;
  start(id: string, port: number) {
    const hostname = connectorHostname(id).trim();
    this.service = new Bonjour();
    this.service.publish({
      name: 'WishOS ' + id.slice(-8),
      host: hostname,
      type: 'wishos',
      protocol: 'tcp',
      port,
      txt: { role: 'connector', id, abi: 'wishos-rpc/1', path: '/os/device' },
    });
    return hostname;
  }
  async close() {
    const service = this.service;
    this.service = undefined;
    if (service) await new Promise<void>((resolve) => service.destroy(() => resolve()));
  }
}
