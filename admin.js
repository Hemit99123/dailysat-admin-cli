import cluster from 'cluster';
import os from 'os';
import pkg from 'pg';
import prompt from 'prompt';
import crypto from 'crypto';
import Redis from 'ioredis';
import 'dotenv/config'; // Load environment variables from .env file

const { Client } = pkg;
const numCPUs = os.cpus().length;

if (cluster.isMaster) {
    // Master process
    console.log(`Master ${process.pid} is running`);

    // Fork workers.
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} died with code ${code} and signal ${signal}`);
    });
} else {
    // Worker processes
    const pgClient = new Client({
        user: process.env.DB_USER,
        host: 'localhost',
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: 5432, // Default PostgreSQL port
    });

    const redisPorts = process.env.REDIS_PORTS.split(',').map(port => ({ port: parseInt(port, 10), host: 'localhost' }));
    const redisClient = new Redis.Cluster(redisPorts);

    redisClient.on('error', (err) => {
        console.error('Redis error:', err);
    });

    const connectToDatabase = async () => {
        try {
            await pgClient.connect();
            console.log('Connected to the database.');
        } catch (error) {
            console.error('Database connection error:', error);
            process.exit(1); // Exit the process if database connection fails
        }
    };

    const promptUser = async (schema) => {
        return new Promise((resolve, reject) => {
            prompt.get(schema, (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(result);
                }
            });
        });
    };

    const updateAdminState = async () => {
        try {
            await connectToDatabase();

            const { email } = await promptUser({
                properties: {
                    email: {
                        description: 'Enter the email of the user to update their admin state:',
                        type: 'string',
                        required: true,
                        message: 'Email cannot be empty'
                    }
                }
            });

            // Ensure table and column names match your schema
            const res = await pgClient.query('SELECT admin FROM user WHERE email = $1', [email]);
            const user = res.rows[0];

            if (!user) {
                console.log('User not found with the provided email.');
                return;
            }

            console.log(`Found user: ${user.username} (Current Admin State: ${user.admin})`);

            const { isAdmin } = await promptUser({
                properties: {
                    isAdmin: {
                        description: 'Set this user as an admin? (yes/no)',
                        type: 'string',
                        pattern: /^(yes|no)$/i,
                        message: 'Answer must be "yes" or "no"',
                        default: user.admin ? 'yes' : 'no'
                    }
                }
            });

            const adminStatus = isAdmin.toLowerCase() === 'yes';

            await pgClient.query('UPDATE user SET admin = $1 WHERE email = $2', [adminStatus, email]);

            const hmac = crypto.createHmac('sha256', process.env.SECRET_KEY || 'default');
            hmac.update(email);
            const sessID = hmac.digest('hex');
            console.log(`User's admin state updated successfully.`);

            await redisClient.del(sessID);
            console.log(`Session ID ${sessID} deleted from Redis.`);

        } catch (err) {
            console.error('Error updating admin state:', err);
        } finally {
            try {
                await pgClient.end();
                redisClient.disconnect(); // Use disconnect() for ioredis
            } catch (err) {
                console.error('Error closing connections:', err);
            }
        }
    };

    prompt.start(); // Start the prompt

    updateAdminState();
}
