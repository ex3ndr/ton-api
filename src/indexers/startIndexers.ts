import { EntityManager } from "typeorm";
import { inTx } from "../inTx";
import { backoff, delay } from '@openland/patterns';
import { fetchBlock, TonBlock } from "../ton/fetchBlock";
import { indexBlockGeneric } from "./workers/indexBlockGeneric";
import { TonIndexerEntity } from "../model/entities";
import { tonClient } from "../ton/tonClient";
import { indexBlockTx } from "./workers/indexBlockTx";

const BATCH_SIZE = 20;

function startIndexer(name: string, version: number, handler: (tx: EntityManager, blocks: TonBlock[]) => Promise<void>) {
    backoff(async () => {

        let latestKnownSeq = (await tonClient.getMasterchainInfo()).latestSeqno;

        while (true) {

            // Do iteration
            let r = await inTx(async (tx) => {

                // Resolve cursor
                let seqnoStart: number;
                let seqnoEnd: number;
                let indexer = await tx.findOne(TonIndexerEntity, { where: { name } });
                if (!indexer) {
                    seqnoStart = 1;
                    seqnoEnd = Math.min(seqnoStart + BATCH_SIZE, latestKnownSeq);
                    if (seqnoStart >= latestKnownSeq) {
                        return false;
                    }

                    // Insert new seq and version
                    await tx.insert(TonIndexerEntity, { name, version, seq: seqnoEnd });
                } else if (indexer.version === version) {
                    seqnoStart = indexer.seq + 1;
                    seqnoEnd = Math.min(seqnoStart + BATCH_SIZE, latestKnownSeq);
                    if (seqnoStart >= latestKnownSeq) {
                        return false;
                    }

                    // Update seq
                    indexer.seq = seqnoEnd;
                    await tx.save(indexer);
                } else if (indexer.version < version) {
                    seqnoStart = 1;
                    seqnoEnd = Math.min(seqnoStart + BATCH_SIZE, latestKnownSeq);
                    if (seqnoStart >= latestKnownSeq) {
                        return false;
                    }

                    // Update seq and version
                    indexer.seq = seqnoEnd;
                    indexer.version = version;
                    await tx.save(indexer);
                } else {
                    throw Error('Incompatible version');
                }

                // Load block
                let start = Date.now();
                let blocksPromises: Promise<TonBlock>[] = [];
                for (let s = seqnoStart; s <= seqnoEnd; s++) {
                    blocksPromises.push(fetchBlock(s));
                }
                let blocks = await Promise.all(blocksPromises);

                // Indexing
                console.log(`[${name}]: Loaded ${seqnoStart}-${seqnoEnd} in ${Date.now() - start} ms`);

                // Handle
                start = Date.now();
                await handler(tx, blocks);
                console.log(`[${name}]: Indexed ${seqnoStart}-${seqnoEnd} in ${Date.now() - start} ms`);

                return true;
            });

            // Refresh seq
            if (!r) {
                await delay(1000);
                latestKnownSeq = (await tonClient.getMasterchainInfo()).latestSeqno;
            }
        }
    });
}

export async function startIndexers() {
    console.log('Starting indexers');
    startIndexer('block_generic', 1, indexBlockGeneric);
    startIndexer('block_tx', 2, indexBlockTx);
}