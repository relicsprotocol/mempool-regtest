const config = require('../../mempool-config.json');
import bitcoinApi from './bitcoin/electrs-api';
import { MempoolInfo, TransactionExtended, Transaction } from '../interfaces';

class Mempool {
  private inSync: boolean = false;
  private mempoolCache: { [txId: string]: TransactionExtended } = {};
  private mempoolInfo: MempoolInfo = { size: 0, bytes: 0 };
  private mempoolChangedCallback: ((newMempool: { [txId: string]: TransactionExtended; }, newTransactions: TransactionExtended[],
    deletedTransactions: TransactionExtended[]) => void) | undefined;

  private txPerSecondArray: number[] = [];
  private txPerSecond: number = 0;

  private vBytesPerSecondArray: any[] = [];
  private vBytesPerSecond: number = 0;

  constructor() {
    setInterval(this.updateTxPerSecond.bind(this), 1000);
  }

  public isInSync() {
    return this.inSync;
  }

  public setMempoolChangedCallback(fn: (newMempool: { [txId: string]: TransactionExtended; },
    newTransactions: TransactionExtended[], deletedTransactions: TransactionExtended[]) => void) {
    this.mempoolChangedCallback = fn;
  }

  public getMempool(): { [txid: string]: TransactionExtended } {
    return this.mempoolCache;
  }

  public setMempool(mempoolData: { [txId: string]: TransactionExtended }) {
    this.mempoolCache = mempoolData;
  }

  public async updateMemPoolInfo() {
    try {
      this.mempoolInfo = await bitcoinApi.getMempoolInfo();
    } catch (err) {
      console.log('Error getMempoolInfo', err);
    }
  }

  public getMempoolInfo(): MempoolInfo | undefined {
    return this.mempoolInfo;
  }

  public getTxPerSecond(): number {
    return this.txPerSecond;
  }

  public getVBytesPerSecond(): number {
    return this.vBytesPerSecond;
  }

  public getFirstSeenForTransactions(txIds: string[]): number[] {
    const txTimes: number[] = [];
    txIds.forEach((txId: string) => {
      if (this.mempoolCache[txId]) {
        txTimes.push(this.mempoolCache[txId].firstSeen);
      } else {
        txTimes.push(0);
      }
    });
    return txTimes;
  }

  public async getTransactionExtended(txId: string): Promise<TransactionExtended | false> {
    try {
      const transaction: Transaction = await bitcoinApi.getRawTransaction(txId);
      return Object.assign({
        vsize: transaction.weight / 4,
        feePerVsize: transaction.fee / (transaction.weight / 4),
        firstSeen: Math.round((new Date().getTime() / 1000)),
      }, transaction);
    } catch (e) {
      console.log(txId + ' not found');
      return false;
    }
  }

  public async updateMempool() {
    console.log('Updating mempool');
    const start = new Date().getTime();
    let hasChange: boolean = false;
    let txCount = 0;
    try {
      const transactions = await bitcoinApi.getRawMempool();
      const diff = transactions.length - Object.keys(this.mempoolCache).length;
      const newTransactions: TransactionExtended[] = [];

      for (const txid of transactions) {
        if (!this.mempoolCache[txid]) {
          const transaction = await this.getTransactionExtended(txid);
          if (transaction) {
            this.mempoolCache[txid] = transaction;
            txCount++;
            if (this.inSync) {
              this.txPerSecondArray.push(new Date().getTime());
              this.vBytesPerSecondArray.push({
                unixTime: new Date().getTime(),
                vSize: transaction.vsize,
              });
            }
            hasChange = true;
            if (diff > 0) {
              console.log('Fetched transaction ' + txCount + ' / ' + diff);
            } else {
              console.log('Fetched transaction ' + txCount);
            }
            newTransactions.push(transaction);
          } else {
            console.log('Error finding transaction in mempool.');
          }
        }

        if ((new Date().getTime()) - start > config.MEMPOOL_REFRESH_RATE_MS) {
          break;
        }
      }

      // Replace mempool to clear deleted transactions
      const newMempool = {};
      const deletedTransactions: TransactionExtended[] = [];
      for (const tx in this.mempoolCache) {
        if (transactions.indexOf(tx) > -1) {
          newMempool[tx] = this.mempoolCache[tx];
        } else {
          deletedTransactions.push(this.mempoolCache[tx]);
        }
      }

      if (!this.inSync && transactions.length === Object.keys(newMempool).length) {
        this.inSync = true;
        console.log('The mempool is now in sync!');
      }

      if (this.mempoolChangedCallback && (hasChange || deletedTransactions.length)) {
        this.mempoolCache = newMempool;
        this.mempoolChangedCallback(this.mempoolCache, newTransactions, deletedTransactions);
      }

      const end = new Date().getTime();
      const time = end - start;
      console.log(`New mempool size: ${Object.keys(newMempool).length} Change: ${diff}`);
      console.log('Mempool updated in ' + time / 1000 + ' seconds');
    } catch (err) {
      console.log('getRawMempool error.', err);
    }
  }

  private updateTxPerSecond() {
    const nowMinusTimeSpan = new Date().getTime() - (1000 * config.TX_PER_SECOND_SPAN_SECONDS);
    this.txPerSecondArray = this.txPerSecondArray.filter((unixTime) => unixTime > nowMinusTimeSpan);
    this.txPerSecond = this.txPerSecondArray.length / config.TX_PER_SECOND_SPAN_SECONDS || 0;

    this.vBytesPerSecondArray = this.vBytesPerSecondArray.filter((data) => data.unixTime > nowMinusTimeSpan);
    if (this.vBytesPerSecondArray.length) {
      this.vBytesPerSecond = Math.round(
        this.vBytesPerSecondArray.map((data) => data.vSize).reduce((a, b) => a + b) / config.TX_PER_SECOND_SPAN_SECONDS
      );
    }
  }
}

export default new Mempool();
